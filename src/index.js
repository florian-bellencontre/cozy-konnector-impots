process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://a43bd181dc0b4a99b4a8085215ca00f1@errors.cozycloud.cc/30'

// This has been added for "Mes papiers" needs
// It must be removed when everything has been sat up and synchronized
// When it will be removed, we will only keep 'refTaxIncome' instead of 'RFR'
const { default: CozyClient } = require('cozy-client')

const {
  CookieKonnector,
  log,
  scrape,
  utils,
  errors,
  cozyClient
} = require('cozy-konnector-libs')

// |Mes papiers|
const flag = require('cozy-flags/dist/flag').default

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const moment = require('moment')
moment.locale('fr')
const sleep = require('util').promisify(global.setTimeout)

const { appendMetadata, formatPhone } = require('./metadata')
// eslint-disable-next-line no-unused-vars
const { getBills } = require('./bills')

const baseUrl = 'https://cfspart.impots.gouv.fr'
const idpUrl = 'https://cfspart-idp.impots.gouv.fr'

// The default user agents of cozy-konnector-libs are too old and are rejected
// by the impots.gouv.fr anti bot protection (HTTP 503 page)
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'

class ImpotsConnector extends CookieKonnector {
  constructor() {
    // this.request (no cheerio) is used by saveFiles/saveBills to download the
    // PDFs with the session cookies
    super({
      cheerio: false,
      json: false,
      userAgent: false,
      headers: { 'User-Agent': USER_AGENT }
    })
    // cheerio instance sharing the same cookie jar, used for scraping
    this.rq = this.requestFactory({
      cheerio: true,
      json: false,
      headers: { 'User-Agent': USER_AGENT }
    })
  }

  // The session (and the device recognition cookie set by the website after a
  // successful OTP validation) is persisted in the account by CookieKonnector.
  // When it is still valid, we can avoid both the login and the OTP challenge.
  async testSession() {
    try {
      log('info', 'Testing previous session...')
      const $ = await this.rq(`${baseUrl}/enp/documents.do?n=0`)
      const isLogged = $('.date').find('a').length > 0
      log(
        'info',
        isLogged ? 'Previous session still valid' : 'Previous session expired'
      )
      return isLogged
    } catch (err) {
      log('debug', `testSession failed: ${err.message}`)
      return false
    }
  }

  async fetch(fields) {
    if (!(await this.testSession())) {
      await this.login(fields)
      await this.saveSession()
    }
    let newDocuments
    try {
      newDocuments = await this.getDocuments()
      newDocuments = appendMetadata(newDocuments)
    } catch (e) {
      log('warn', 'Error during new documents collection')
      log('warn', e.message)
    }
    log('info', 'saving all files')
    if (process.env.NODE_ENV === 'standalone') {
      // The saveFiles of cozy-konnector-libs needs a real cozy stack (the
      // standalone stub does not implement the new cozy-client api), so we
      // only download the files in ./data and stop here
      await this.saveFilesStandalone(newDocuments)
      log(
        'warn',
        'Standalone mode: files downloaded to ./data, identity and metadata steps need a real cozy (yarn dev)'
      )
      return
    }
    const files = await this.saveFiles(newDocuments, fields, {
      contentType: 'application/pdf',
      fileIdAttributes: ['idEnsua']
    })

    // BYPASSING BILLS FETCH AS PAIMENTS DO NOT WORK
    /* const bills = await getBills(cleanLogin(fields.login), newDocuments)
    log('info', 'saving all bills')
    await this.saveBills(bills, fields, {
      contentType: 'application/pdf',
      fileIdAttributes: ['idEnsua'],
      linkBankOperations: false
    })
    */
    try {
      log('info', 'Fetching identity ...')
      const ident = await this.fetchIdentity(files)
      if (ident.housing === null) {
        log('warn', 'No housing infos available, deleting "housing" property')
        delete ident.housing
      }
      // Due to "Mes papiers" needs, we have to update the metadata to add the "RFR" value found during pdfs parsing.
      await updateMetadata(files, ident.tax_informations)
      await this.saveIdentity(ident, cleanLogin(fields.login))
    } catch (e) {
      log('warn', 'Error during identity scraping or saving')
      log('warn', e.message)
    }
  }

  async login(fields) {
    log('info', 'Logging in')
    await this.deactivateAutoSuccessfulLogin()
    validateLogin(cleanLogin(fields.login))
    let $

    // Precheck Fiscal Number, not mandatory, only for login_failed detection
    await this.rq.get(baseUrl)
    try {
      $ = await this.rq({
        method: 'POST',
        uri: `${idpUrl}/GetContexte`,
        form: {
          url: '',
          lmAuth: '',
          spi: cleanLogin(fields.login)
        }
      })
    } catch (err) {
      log('error', 'Website failed while trying to login')
      log('error', err)
      throw new Error(errors.VENDOR_DOWN)
    }
    if ($.html().includes("postMessage('ctx,BLOCAGE'")) {
      log('error', 'Account seems blocked')
      throw new Error('USER_ACTION_NEEDED')
    }
    if ($.html().includes("postMessage('ctx,EXISTEPAS")) {
      log('error', 'Fiscal number does not exist')
      throw new Error(errors.LOGIN_FAILED)
    }

    if ($.html().includes("postMessage('ctx,3S'")) {
      log(
        'warn',
        `Vous devez créer votre espace en saisissant votre numéro d'accès en ligne et votre revenu fiscal de référence.`
      )
      throw new Error('USER_ACTION_NEEDED.CREATE_ACCOUNT')
    }

    try {
      $ = await this.rq({
        method: 'POST',
        uri: `${idpUrl}/`,
        form: {
          url: '',
          lmAuth: 'LDAP',
          authType: '',
          spi: cleanLogin(fields.login),
          pwd: fields.password,
          fg: ''
        }
      })
    } catch (err) {
      log('error', 'Website failed while trying to login')
      log('error', err)
      throw new Error(errors.VENDOR_DOWN)
    }

    // Since 2025-06-25, the website sends a 6 digits security code by email
    // when the browser is not recognized (mandatory 2FA, email only)
    let otpHandled = false
    if (isOtpRequested($)) {
      $ = await this.handleOtpChallenge($)
      otpHandled = true
    }

    // Expect a 200 received here. Login success and login failed come here
    if ($.html().includes("postMessage('ok,")) {
      let confirmUrl = $.html().match(/postMessage\('ok,([^']*)'/)[1]
      if (confirmUrl) {
        confirmUrl = confirmUrl.replace(/\+/g, ' ')
        await this.rq(confirmUrl)
        log('info', 'Successfully logged in')
      }
    } else if (otpHandled && (await this.testSession())) {
      // After the OTP validation, the website may open the session directly
      // without going through the usual postMessage redirect
      log('info', 'Successfully logged in after OTP validation')
    } else if ($.html().includes("postMessage('lmdp,4665'")) {
      log('error', 'detected a maintenance, lmdp,4665')
      throw new Error(errors.VENDOR_DOWN + '.MAINTENANCE')
    } else if ($.html().includes("postMessage('lmdp")) {
      log('error', 'Password seems wrong')
      throw new Error(errors.LOGIN_FAILED)
    } else {
      log('error', 'Final login request return unknown status')
      dumpHtml('login-unknown.html', $.html())
      throw new Error(errors.UNKNOWN_ERROR)
    }
    await this.notifySuccessfulLogin()
  }

  // The OTP form is included in the body of the response to the credentials
  // POST (the website copies it in place of the login form). We fill it with
  // the code received by email by the user and submit it back.
  async handleOtpChallenge($page) {
    let $ = $page
    log('info', 'Website is asking for an email security code (2FA)')
    dumpHtml('otp-form.html', $.html())
    const maxAttempts = 2
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // The page contains two forms with the same otpform id, the first one
      // is the one submitted by the website javascript
      let $form = $('#otpform').first()
      if ($form.length === 0) {
        $form = $('#extcode').closest('form')
      }
      if ($form.length === 0) {
        log('error', 'OTP challenge detected but no form found in response')
        throw new Error(errors.VENDOR_DOWN)
      }
      const action = $form.attr('action') || `${idpUrl}/`
      const formData = {}
      $form.find('input[name]').each((idx, el) => {
        const $el = $(el)
        if ($el.attr('disabled') !== undefined) return
        const type = ($el.attr('type') || 'text').toLowerCase()
        if (['submit', 'button', 'image'].includes(type)) return
        if (
          ['checkbox', 'radio'].includes(type) &&
          $el.attr('checked') === undefined
        ) {
          return
        }
        formData[$el.attr('name')] = $el.attr('value') || ''
      })

      // The security code input is named "code" (hidden input with id
      // extcode, filled by the website javascript before submitting)
      formData.code = await this.getOtpCode(attempt > 1)

      try {
        $ = await this.rq({
          method: 'POST',
          uri: new URL(action, `${idpUrl}/`).href,
          form: formData
        })
      } catch (err) {
        log('error', 'Website failed while submitting the OTP code')
        log('error', err.message)
        throw new Error(errors.VENDOR_DOWN)
      }

      if (!isOtpRequested($)) {
        log('info', 'OTP code accepted')
        return $
      }
      log('warn', 'OTP code refused by the website')
      dumpHtml(`otp-refused-${attempt}.html`, $.html())
    }
    throw new Error(errors.USER_ACTION_NEEDED_WRONG_TWOFA_CODE)
  }

  // Minimal local replacement of saveFiles for the standalone mode
  async saveFilesStandalone(entries) {
    const folder = path.resolve('data')
    fs.mkdirSync(folder, { recursive: true })
    for (const entry of entries) {
      const filePath = path.join(folder, entry.filename)
      if (fs.existsSync(filePath)) {
        log('debug', `${entry.filename} already downloaded`)
        continue
      }
      try {
        const body = await this.request({
          uri: entry.fileurl,
          encoding: null
        })
        if (!body || body.slice(0, 4).toString() !== '%PDF') {
          log('warn', `${entry.filename} does not look like a PDF, skipping`)
          continue
        }
        fs.writeFileSync(filePath, body)
        log('info', `Saved ${entry.filename}`)
      } catch (err) {
        log('warn', `Could not download ${entry.filename}: ${err.message}`)
      }
    }
    return entries
  }

  async getOtpCode(retry = false) {
    if (['standalone', 'development'].includes(process.env.NODE_ENV)) {
      // In local dev, the 2FA code cannot be transmitted through the account
      // like in a real Cozy, so we ask for it on the console
      return promptForCode(
        retry
          ? 'Code refusé. Nouveau code de sécurité reçu par email : '
          : 'Code de sécurité reçu par email : '
      )
    }
    return this.waitForTwoFaCode({ type: 'email', retry })
  }

  async getDocuments() {
    log('info', 'Getting documents on new interface')
    try {
      let docs = []
      const $ = await this.rq(`${baseUrl}/enp/documents.do?n=0`)
      let years = Array.from(
        $('.date')
          .find('a')
          .map((idx, el) => {
            const year = el.children
              .filter(tag => tag.type === 'text')
              .map(t => t.data)
              .join('')
              .trim()
            if (year.match(/^\d{4}$/) === null) {
              throw 'Docs year scraping failed'
            }
            return Number(year)
          })
      )

      log('debug', `Docs available for years ${years}`)
      for (const year of years) {
        // Needs to be different in first place to enter the loop
        let testLength = 0
        let baseLength = 1
        let tmpDocs
        let loop = 1
        // Let 3 loops maximum and go with what has been found
        while (baseLength !== testLength && loop < 3) {
          log('debug', `${loop} loop`)
          const $year = await this.rq(`${baseUrl}/enp/documents.do?n=${year}`)
          tmpDocs = Array.from(
            $year('.documents')
              .find('ul[class="list-unstyled documents"] > li')
              .map((idx, el) => {
                let label = $year(el)
                  .find('div.hidden-xs.texte > span')
                  .text()
                  .trim()
                if (label.length === 0) {
                  label = $year(el)
                    .find(
                      'div[class="visible-xs col-xs-5 texte_docslies"] > span'
                    )
                    .text()
                    .trim()
                }
                if (label.match(/Décla\s/g)) {
                  log('debug', 'getting in décla matching condition')
                  label = label.replace('Décla', 'Déclaration')
                }
                const idEnsua = $year(el).find('input').attr('value')
                let filename = `${year}-${label}.pdf`
                // Replace / and : found in some labels
                // 1) in date (01/01/2018 -> 01-01-2018)
                filename = filename.replace(/\//g, '-')
                // 2) in complementrary form
              filename = filename.replace(' : ', ' - ') // eslint-disable-line
                filename = filename.replace(' : ', ' - ')
                // 3) replace time (19:26 -> 19h26)
                filename = filename.replace(':', 'h')
                return {
                  year,
                  label,
                  idEnsua,
                  filename,
                  fileurl:
                    `https://cfspart.impots.gouv.fr/enp/Affichage_Document_PDF` +
                    `?idEnsua=${idEnsua}`
                }
              })
          )
          if (!testLength) {
            log('debug', 'first testLength definition')
            testLength = tmpDocs.length
          }
          if (testLength > baseLength) {
            log('debug', 'testLength is greater, becoming baseLength')
            baseLength = testLength
            testLength = 0
          }
          loop++
          // Need to wait here, if not, all documents may not be available + it avoid spamming requests
          await sleep(1000)
        }
        log('info', `${tmpDocs.length} docs found for year ${year}`)
        docs = docs.concat(tmpDocs)
      }
      return docs
    } catch (err) {
      if (err.statusCode === 503) {
        log('error', err.message)
        throw new Error('VENDOR_DOWN')
      }
    }
  }

  async fetchIdentity(files) {
    // Prefetch is mandatory if we want maritalStatus
    await this.rq('https://cfspart.impots.gouv.fr/enp/redirectpas.do')
    await sleep(5000) // Need to wait here, if not, maritalStatus is not available
    let $ = await this.rq('https://cfspart.impots.gouv.fr/tremisu/accueil.html')
    const result = { contact: {}, tax_informations: {}, housing: {} }

    result.contact.maritalStatus = $('#libelle-sit-fam').text().trim()
    result.contact.numberOfDependants = Number(
      $('.p-nb-pac').text().split(':').pop().trim()
    )
    result.tax_informations = await this.fetchTaxInfos(files)
    result.housing = await this.fetchHousingInfos()
    // Not used for identities, but can be useful later
    // result.contact.tauxImposition = parseFloat(
    //   $('#libelle-tx-foyer')
    //     .text()
    //     .replace(',', '.')
    //     .replace('%', '')
    //     .trim()
    // )

    $ = await this.rq('https://cfspart.impots.gouv.fr/enp/chargementprofil.do')

    $ = await this.rq('https://cfspart.impots.gouv.fr/enp/affichageadresse.do')
    const infos = scrape(
      $,
      { key: '.labelInfo', value: '.inputInfo' },
      '.infoPersonnelle > dl > dd'
    )

    // extractible datas :
    // {
    //    'Prénom': 'PRENOM',
    //    Nom: 'NOM',
    //    'Date de naissance': '1 janvier 1980',
    //    'Lieu de naissance': 'VILLE (57)',
    //    'Adresse électronique validée': 'mail@mail.com',
    //    'Téléphone portable': '+33 0606060606',
    //    'Téléphone fixe': '+33 0909090909'
    //    'Adresse postale': '2 RUE DU MOULIN00001 VILLE'
    //  }

    // We extracted the address this way to be able to keep the cariage return information
    //  and parse it
    const formattedAddress = $('#adressepostale').html().replace('<br>', '\n')

    const linesAddress = formattedAddress.split(/\n|<br>/)
    // <br> is found in some long address as line separator
    const lastLineAddress = linesAddress.pop() // Remove the city line from array
    const street = linesAddress.join('\n')
    const lastLineMatch = lastLineAddress.match(/^\d{5}/)
    const postcode = lastLineMatch ? lastLineMatch[0] : null
    const city = lastLineAddress.replace(postcode, '').trim()

    // Structuring as a io.cozy.contacts
    const maritalStatusTable = {
      'marié(e)': 'married',
      'divorcé(e)/séparé(e)': 'separated',
      'pacsé(e)': 'pacs',
      célibataire: 'single',
      'veuf(ve)': 'widowed'
    }
    result.contact.maritalStatus =
      maritalStatusTable[result.contact.maritalStatus]
    result.contact.address = [{ formattedAddress, street, postcode, city }]

    for (const info of infos) {
      if (info.key === 'Prénom') {
        result.contact.name = { givenName: info.value }
      } else if (info.key === 'Nom') {
        result.contact.name.familyName = info.value
      } else if (info.key === 'Date de naissance') {
        result.contact.birthday = moment(
          info.value,
          'DD MMMM YYYY',
          'fr'
        ).format('YYYY-MM-DD')
      } else if (info.key === 'Lieu de naissance') {
        result.contact.birthplace = info.value
      } else if (info.key === 'Adresse électronique validée') {
        result.contact.email = [{ address: info.value }]
      } else if (info.key === 'Téléphone portable') {
        if (info.value != '') {
          if (result.contact.phone) {
            result.contact.phone.push({
              type: 'mobile',
              number: formatPhone(info.value)
            })
          } else {
            result.contact.phone = [
              { type: 'mobile', number: formatPhone(info.value) }
            ]
          }
        }
      } else if (info.key === 'Téléphone fixe') {
        if (info.value != '') {
          if (result.contact.phone) {
            result.contact.phone.push({
              type: 'home',
              number: formatPhone(info.value)
            })
          } else {
            result.contact.phone = [
              { type: 'home', number: formatPhone(info.value) }
            ]
          }
        }
      }
    }
    return result
  }

  async fetchTaxInfos(files) {
    const rawTaxInfos = []
    let fiscalRefRevenue
    let taxNotices = []
    // We admit that we will refer to the "Avis d'impôt" files to find the real taxInformations
    // So we're looping on each file to only keep the "Avis d'impôt" from each year.
    for (const file of files) {
      if (file.filename.match(/Avis d'impôt/)) {
        taxNotices.push(file)
      }
    }
    for (let i = 0; i < taxNotices.length; i++) {
      let fileId
      try {
        fileId = taxNotices[i].fileDocument._id
      } catch (err) {
        log('error', err)
        log(
          'warn',
          'Impossible to fetch the file, maybe due to disk quota reached'
        )
      }
      const resp = await utils.getPdfText(fileId)
      log('info', 'fetchTaxInfo first year')
      let year = taxNotices[i].fileAttributes.metadata.year
      log('info', 'fetchTaxInfo after first year')
      if (year === undefined) {
        const getYear = taxNotices[i].filename.split('-')
        year = getYear[0]
      }
      try {
        const transform = await findTransform(resp)
        fiscalRefRevenue = transform
      } catch (err) {
        log('info', 'No matching found, continue')
      }
      const firstAJ = resp.text.match(/Déclar\. 1\n\n([0-9]*)\n/)[1]
      let firstBJ = undefined
      if (resp.text.match(/Déclar\. 2\n\n([0-9]*)\n/)) {
        firstBJ = resp.text.match(/Déclar\. 2\n\n([0-9]*)\n/)[1]
      }

      if (firstAJ) {
        if (firstAJ && firstBJ) {
          rawTaxInfos.push({
            filename: taxNotices[i].filename,
            year: parseInt(year),
            declarers: {
              firstAJ,
              firstBJ
            }
          })
        } else {
          log('info', 'no 1BJ line found, saving 1AJ only')
          rawTaxInfos.push({
            filename: taxNotices[i].filename,
            year: parseInt(year),
            declarers: { firstAJ }
          })
        }
      }
      if (fiscalRefRevenue != null) {
        rawTaxInfos.push({
          filename: taxNotices[i].filename,
          year: parseInt(year),
          fiscalRefRevenue: fiscalRefRevenue
        })
      }
    }
    const taxInfos = await this.formatTaxInfos(rawTaxInfos)
    return taxInfos
  }

  async fetchHousingInfos() {
    try {
      let housingInfos = []
      log('debug', 'Getting in fetchHousingInfos')
      const $ = await this.rq(
        'https://cfspart.impots.gouv.fr/gmbi-mapi/accueil/flux.ex?_flowId=accueil-flow'
      )
      // For the following comparison, we need to remove every whitespaces found as the website uses different encoding.
      // Otherwise, the line won't match with the expected result even if it looks the same.
      const haveProperty = $('p[role="heading"] > span > strong')
        .text()
        .replace(/\s+/g, '')
      const compareString = "Aucun bien n'a été trouvé.".replace(/\s+/g, '')
      if (haveProperty === compareString) {
        log('info', 'No properties owned, returning null')
        return null
      }
      const typeElements = Array.from($('span > span[class="type-bien"]'))
      const foundedType = []
      for (const element of typeElements) {
        foundedType.push($(element).text())
      }
      const cityElements = Array.from($('span > span[class="ville"]'))
      const foundedCity = []
      for (const element of cityElements) {
        foundedCity.push($(element).text())
      }
      const addressElements = Array.from($('span[class="adresse"]'))
      const foundedAddress = []
      for (const element of addressElements) {
        foundedAddress.push($(element).text())
      }
      const livingSpaceSizeElements = Array.from(
        $('span[class="bulles-infos"] > span[class="bulle"]:nth-child(1)')
      )
      const foundedLivingspaceSize = []
      for (const element of livingSpaceSizeElements) {
        foundedLivingspaceSize.push($(element).text())
      }
      const uniqEntitySize = []
      for (let i = 0; i < foundedLivingspaceSize.length; i++) {
        uniqEntitySize.push(foundedLivingspaceSize[i])
      }
      for (let i = 0; i < foundedType.length; i++) {
        let housing_type = foundedType[i].trim()
        const housing_type_EN = await housingTypeTraduction(housing_type)
        const cityAndPostcode = foundedCity[i]
          .replace(/\s{1,}/g, '-')
          .replace(/\(|\)/g, '')
          .split('-')
        const cityCap = cityAndPostcode[0]
        const city = cityCap[0] + cityCap.toLowerCase().substring(1)
        const street = foundedAddress[i].trim().toLowerCase()
        const postcode = cityAndPostcode[1]
        const living_space_m2 = parseInt(uniqEntitySize[i], 10)
        housingInfos.push({
          address: {
            formattedAddress: `${street}, ${postcode} ${city}`,
            street,
            postcode,
            city
          },
          housing_type: housing_type_EN,
          living_space_m2
        })
      }
      return housingInfos
    } catch (err) {
      log(
        'warn',
        `An error "${err.message}" prevents housing scraping, aborting step`
      )
    }
  }

  async formatTaxInfos(rawTaxInfos) {
    log('info', 'Starting to format tax information')
    const availableYears = []
    const tax_informations = []
    rawTaxInfos.forEach(info => {
      if (info.year) {
        availableYears.push(info.year)
      }
    })
    const uniqYears = [...new Set(availableYears)]

    for (let i = 0; i < uniqYears.length; i++) {
      let firstAJ
      let firstBJ
      let RFR
      let year
      let fileRFR
      let fileFirstJ
      for (let j = 0; j < rawTaxInfos.length; j++) {
        if (rawTaxInfos[j].year === uniqYears[i]) {
          year = rawTaxInfos[j].year
          if (rawTaxInfos[j].declarers) {
            firstAJ = parseInt(rawTaxInfos[j].declarers.firstAJ)
            if (!rawTaxInfos[j].declarers.firstBJ) {
              firstBJ = null
            } else {
              firstBJ = parseInt(rawTaxInfos[j].declarers.firstBJ)
            }
            fileFirstJ = rawTaxInfos[j].filename
          }
          if (rawTaxInfos[j].fiscalRefRevenue) {
            RFR = rawTaxInfos[j].fiscalRefRevenue
            fileRFR = rawTaxInfos[j].filename
          }
        }
      }
      const foundTaxInfos = {
        year: year,
        // RFR: RFR,
        '1AJ': firstAJ,
        '1BJ': firstBJ,
        net_monthly_income: parseFloat((RFR / 12).toFixed(2)),
        currency: 'EUR',
        files: {
          '1AJ': fileFirstJ,
          '1BJ': fileFirstJ
          // RFR: fileRFR
        }
      }
      // |Mes papiers|
      this.client = CozyClient.fromEnv()
      await this.client.registerPlugin(flag.plugin)
      await this.client.plugins.flags.initializing
      if (flag('mespapiers.migrated.metadata')) {
        foundTaxInfos.refTaxIncome = RFR
        foundTaxInfos.files.refTaxIncome = fileRFR
      } else {
        foundTaxInfos.RFR = RFR
        foundTaxInfos.files.RFR = fileRFR
      }
      // ====
      tax_informations.push(foundTaxInfos)
    }
    return tax_informations
  }
}

function cleanLogin(login) {
  return login.replace(/\s|[A-Z]|[a-z]/g, '')
}

function validateLogin(login) {
  if (login.includes('@') || login.includes('.')) {
    throw new Error('LOGIN_FAILED.FRANCE_CONNECT_LOGIN')
  }

  if (login.length !== 13) {
    log('error', `login length is ${login.length}`)
    throw new Error('LOGIN_FAILED')
  }
}

function isOtpRequested($) {
  return (
    $.html().includes("postMessage('otp") ||
    $('#otpform').length > 0 ||
    $('#extcode').length > 0
  )
}

function promptForCode(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// Dump the html of a response in the data directory to ease debugging, only
// in local dev modes
function dumpHtml(filename, html) {
  if (!['standalone', 'development'].includes(process.env.NODE_ENV)) return
  try {
    fs.mkdirSync(path.resolve('data'), { recursive: true })
    fs.writeFileSync(path.resolve('data', filename), html)
    log('info', `Response dumped to data/${filename}`)
  } catch (err) {
    log('debug', err.message)
  }
}

async function updateMetadata(files, taxInfos) {
  log('info', 'updating metadata')
  for (const file of files) {
    // Check if file correctly exist on cozy after download
    if (!file.fileDocument) {
      continue
    }

    // Get the RFR on wanted files
    if (file.filename.includes("Avis d'impôt")) {
      // First removing all not "avis d'impots"
      const fileFromCozy = await cozyClient.new
        .collection('io.cozy.files')
        .get(file.fileDocument._id)
      // Only then, removing all file with a RFR already
      if (
        !(
          fileFromCozy.data.metadata.RFR ||
          fileFromCozy.data.metadata.refTaxIncome
        )
      ) {
        const RFRForCurrentYear = findMatchingTaxInfo(
          file.fileAttributes.metadata.year,
          taxInfos
        )
        const newMetadata = {
          ...fileFromCozy.data.metadata
          // RFR: RFRForCurrentYear
        }
        // |Mes papiers|
        if (flag('mespapiers.migrated.metadata')) {
          newMetadata.refTaxIncome = RFRForCurrentYear
        } else {
          newMetadata.RFR = RFRForCurrentYear
        }
        // ====
        await cozyClient.new
          .collection('io.cozy.files')
          .updateMetadataAttribute(file.fileDocument._id, newMetadata)
      }
    }
    // Get the real issueDate of the file
    if (isArbitraryDate(file.fileAttributes.metadata.issueDate)) {
      const foundDate = await findRealIssueDate(file)
      if (foundDate) {
        log('info', 'Found realIssueDate, updating file')
        const fileFromCozy = await cozyClient.new
          .collection('io.cozy.files')
          .get(file.fileDocument._id)

        const newMetadata = {
          ...fileFromCozy.data.metadata,
          issueDate: foundDate,
          datetime: foundDate,
          datetimeLabel: 'issueDate'
        }
        await cozyClient.new
          .collection('io.cozy.files')
          .updateMetadataAttribute(file.fileDocument._id, newMetadata)
      }
      log('info', 'Nothing to update')
    }
    if (file.filename.includes('taxes foncières')) {
      const paymentLimitDate = await findPaymentLimitDate(file)
      if (paymentLimitDate) {
        log('info', 'Found a paymentLimitDate, updating file')
        const fileFromCozy = await cozyClient.new
          .collection('io.cozy.files')
          .get(file.fileDocument._id)

        const newMetadata = {
          ...fileFromCozy.data.metadata,
          paymentLimitDate
        }
        await cozyClient.new
          .collection('io.cozy.files')
          .updateMetadataAttribute(file.fileDocument._id, newMetadata)
        continue
      }
      log('info', 'Nothing to update')
    }
    if (
      file.filename.match(
        /Avis d'impôt|Avis impôts sur|Déclaration|foncières?|Avis échéancier|Échéancier/g
      )
    ) {
      if (file.filename.includes('réductions')) {
        log('info', 'No taxNumber on this type of documents, jumping it')
        continue
      }
      const fileFromCozy = await cozyClient.new
        .collection('io.cozy.files')
        .get(file.fileDocument._id)
      if (
        !fileFromCozy.data.metadata.number ||
        fileFromCozy.data.metadata.number.includes(' ') ||
        fileFromCozy.data.metadata.number.includes('\n')
      ) {
        const taxNumber = await findTaxNumber(file)
        if (taxNumber) {
          log('info', 'Found taxNumber, updating file')
          const fileFromCozy = await cozyClient.new
            .collection('io.cozy.files')
            .get(file.fileDocument._id)

          const newMetadata = {
            ...fileFromCozy.data.metadata,
            number: taxNumber.trim()
          }
          if (newMetadata.taxNumber) {
            delete newMetadata.taxNumber
          }
          await cozyClient.new
            .collection('io.cozy.files')
            .updateMetadataAttribute(file.fileDocument._id, newMetadata)
        } else {
          log(
            'info',
            'Cannot find taxNumber, can be an unknown case, jumping this file'
          )
          continue
        }
      }
    }
  }
}

function findMatchingTaxInfo(searchedYear, taxInfos) {
  for (const taxInfosForOneYear of taxInfos) {
    if (taxInfosForOneYear.year === searchedYear) {
      // |Mes papiers|
      return taxInfosForOneYear.RFR
        ? taxInfosForOneYear.RFR
        : taxInfosForOneYear.refTaxIncome
      // ====
    }
  }
}

function isArbitraryDate(date) {
  if (date.getDate() === 1 && date.getMonth() === 0) {
    log('debug', 'is arbitrary date')
    return true
  } else {
    log('debug', 'is good date')
    return false
  }
}

async function findRealIssueDate(file) {
  log('debug', 'findRealIssueDate starts')
  const isValidFile = await checkFileName(file.filename)
  if (!isValidFile) {
    log('info', 'File does not contains any date')
    return null
  }
  const fileId = file.fileDocument._id
  let realDate
  const resp = await utils.getPdfText(fileId)
  const foundDates = resp.text.match(
    /(\d{2}\/\d{2}\/\d{4})\n|(Horodatage : )(\d{2}\/\d{2}\/\d{4})/g
  )
  if (foundDates === null) {
    // Log only the 4 firsts words of the filename for unknown case
    log(
      'info',
      `Cannot find any date for ${file.filename
        .split(' ')
        .slice(0, 4)
        .join(' ')}')`
    )
    return null
  } else {
    // Until now, every know case shows the issueDate is always the first in the array if we found some
    foundDates[0].match('Horodatage')
      ? (realDate = foundDates[0].split(': ')[1])
      : (realDate = foundDates[0].replace('\n', ''))
  }
  const [day, month, year] = realDate.split('/')
  return new Date(`${year}-${month}-${day}`)
}

function checkFileName(filename) {
  // Some files did not have any dates so this is done with known case
  // of what's inside the different pdfs, list is subject to additions in the future
  if (filename.match(/Déclaration automatique/)) {
    log('info', 'No dates available on "Déclaration automatique" files')
    return null
  }
  return true
}

async function findPaymentLimitDate(file) {
  log('debug', 'findPaymentLimitDate starts')
  const fileId = file.fileDocument._id
  let limitPaymentDate
  const resp = await utils.getPdfText(fileId)
  const foundDate = resp.text.match(
    /(Date limite de paiement : )(\d{2}\/\d{2}\/\d{4})|(Au plus tard le\n \n)(\d{2}\/\d{2}\/\d{4})/g
  )

  if (foundDate) {
    const dateString = foundDate[0]
    limitPaymentDate = dateString.match('limite de paiement')
      ? dateString.split(' : ')[1]
      : dateString.split(' \n')[1]
    const [day, month, year] = limitPaymentDate.split('/')
    return new Date(`${year}-${month}-${day}`)
  } else {
    log('info', 'No payment limit date found for this file')
    return null
  }
}

async function findTaxNumber(file) {
  log('debug', 'findtaxNumber starts')
  const fileId = file.fileDocument._id
  let taxNumber
  const resp = await utils.getPdfText(fileId)
  const foundTaxNumber = resp.text.match(
    /\d{2} \d{2} \d{3} \d{3} \d{3}\n?|n° fiscal : \d{13}|\n(\d{13} [A-Z]{1})\n/g
  )
  if (foundTaxNumber.length > 1) {
    // Until now, everytime we found more than one number, the first one found is the user's number
    taxNumber = foundTaxNumber[0].replace(/ /g, '')
  } else if (foundTaxNumber[0].includes('fiscal')) {
    taxNumber = foundTaxNumber[0].split(':')[1].trim()
  } else if (foundTaxNumber[0].includes('\n')) {
    taxNumber = foundTaxNumber[0].replace(/\n|( [A-Z]\n)|\s/g, '')
  } else {
    return null
  }
  return taxNumber
}

// findTransfrorm will find top-margin of the cell with wanted string and match the value associated
async function findTransform(resp) {
  log('debug', 'Starting findTransform')
  let matchedAmount
  let compareTransform
  // If true, get the last index of the compareTransform array as it is the top-margin of the cell
  for (let j = 1; j < Object.keys(resp).length; j++) {
    for (let i = 0; i < resp[j].length; i++) {
      const string = resp[j][i].str
      const findTransform = resp[j][i].transform
      if (string === `Revenu fiscal de référence`) {
        compareTransform = findTransform.pop()
      }
    }
    // If true, the value in the cell matching the top-margin found above is saved
    for (let i = 0; i < resp[j].length; i++) {
      const string = resp[j][i].str
      const findTransform = resp[j][i].transform.pop()
      if (findTransform === compareTransform) {
        matchedAmount = parseInt(string, 10)
      }
    }
  }
  // Return the value of the matched
  return matchedAmount
}

async function housingTypeTraduction(type) {
  if (type === 'Appartement') {
    return 'apartment'
  }
  if (type === 'Garage') {
    return 'garage'
  }
  if (type === 'Cave, cellier, buanderie...') {
    return 'cellar, laundry ...'
  }
  if (type === 'Maison') {
    return 'house'
  }
  if (type === 'Parking') {
    return 'parking'
  }
  return type.toLowerCase()
}

const connector = new ImpotsConnector()
connector.run()

module.exports = connector
