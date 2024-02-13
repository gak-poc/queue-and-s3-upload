const {
  SQS
} = require("@aws-sdk/client-sqs");
const SITE_URL = 'https://srw.pteacademic.com/login';
const axios = require('axios');
const path = require('path');
const downloadPath = path.resolve('./output');
const fs = require('fs/promises');
const dayjs = require('dayjs')
const { REGION } = require("./config");


function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const queryPTE = async (browser_handler, username, password, trf_number) => {
  console.log('NEW PTE query', new Date(), trf_number);
  const result = [];
  const pages = await browser_handler.browser.pages();
  if (pages.length === 0) {
    pages.push(await browser_handler.browser.newPage());
  }
  const page = pages.find(d => d.url().match(/(srw\.pteacademic\.com|about:blank)/)) || (await browser_handler.browser.newPage());
  page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36")

  const url = await page.url();
  console.log('PTE', url)
  const login = async (username, password) => {

    try {
      await page.waitForSelector('input[type="password"]', { timeout: 5000 })
      await page.type('input[name="login"]', username);
      await page.type('input[type="password"]', password);
    } catch (e) {
      console.log('PTE: login_issue', e);
    }
    
    await Promise.all([
      page.click('[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle0' })]
    )
    console.log('PTE: login complete', new Date());
  }

  // formcontrolname="scoreReportNumber"
  const capture = async (trf_number) => {
    console.log('PTE: capture', trf_number)
    try {
      await page.waitForSelector('input[formcontrolname="scoreReportNumber"]', { timeout: 2000 });
    } catch (e) {
      console.log('queryPTE', e)
      if (e instanceof TimeoutError) {
        // Do something if this is a timeout.
        console.log('queryPTEDDD', e)
      }
    }
    console.log('queryPTEcapture2', trf_number)
    await page.type('input[formcontrolname="scoreReportNumber"]', trf_number);
    page.click('[type="submit"]', { timeout: 2000 })
    // await Promise.all([
    //   page.click('[type="submit"]', { timeout: 2000 }),
    //   page.waitForNavigation({ waitUntil: 'networkidle0' })]
    // );
    console.log('queryPTEcapture4', trf_number)
    await timeout(5000);
    try {
      await page.waitForSelector('.more-result-button', { timeout: 2000 });
      await page.click('[type="button"]', { timeout: 2000 });
    } catch (e) {
      console.log('queryPTE', e)
    }
    await timeout(5000);
  };

  if (url.match(/(srw\.pteacademic\.com|about:blank)/)) {
    await page.setRequestInterception(true);
    await page._client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath
    });
    page.on('request', async request => {
      if (request.url().match(/(www.google-analytics.com|www.googletagmanager.com|geolocation.onetrust.com|cdn.cookielaw.org)/)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    page.on('requestfinished', async (request) => {
      if (request.url().match(/api.pearson.com\/srw\/api\/v1\/scoreReports/)) {
        let responseBody;
        if (request.redirectChain().length === 0) {
          const response = await request.response();
          // Because body can only be accessed for non-redirect responses.
          responseBody = JSON.parse((await response.buffer()).toString());
          result.push(responseBody);
        }
      }
    });
    page._client.on('Page.downloadWillBegin', ({ url, suggestedFilename }) => {
      console.log('download beginning,', url, suggestedFilename);
      fileName = suggestedFilename;
    });

    page._client.on('Page.downloadProgress', ({ state }) => {
      if (state === 'completed') {
        console.log('download completed. File location: ', downloadPath + '/' + fileName);
        result.push(downloadPath + '/' + fileName);
      }
    });
    console.log('PTE: SITE_URL', SITE_URL)
    await page.goto(SITE_URL, { waitUntil: 'networkidle2' });
    console.log('Query page open', new Date());
    
    await login(username, password);
    

    await capture(trf_number);
    await timeout(1000);
    await page.close();
  } else {
    throw Error(`PTE: Processing...${url}`);
  }
  return result;

}

const processPTE = async (result, params, tenantId, requestQueue, stage) => {
  console.log('processPTE', requestQueue, params);
  if (Array.isArray(result) && result.length === 3) {
    const [pte_results, profile_photo, pte_pdf] = result;
    const options = {
      headers: {
        "Content-Type": "image/png",
        "Content-Encoding": "base64"
      }
    }
    try {
      await fs.writeFile(path.resolve(`${downloadPath}/profile.png`), profile_photo.fileContent, 'base64');
      const data = await fs.readFile(`${downloadPath}/profile.png`);
      await axios.put(params.preSignedFilePathProfilePic, Buffer.from(data, "base64"), options);
    } catch (e) {
      console.log(e);
    }
    const { score } = pte_results;
    const { communicativeSkills } = score;
    const keys = ['gender', 'testDate', 'candidateId', 'middleName', 'countryOfResidence', 'countryOfCitizenShip', 'scoreReportNumber', 'firstName', 'lastName', 'dateOfBirth', 'gseScore'];
    const new_values = keys.filter(key => score[key]).reduce((pv, key) => {
      pv[key] = (['testDate', 'dateOfBirth'].indexOf(key) > -1) ? dayjs(score[key]).format('YYYY-MM-DD') : score[key];
      return pv;
    }, {});
    Object.keys(communicativeSkills).forEach(key => new_values[key] = communicativeSkills[key]);

    try {
      const data = await fs.readFile(pte_pdf);
      await axios.put(params.preSignedFilePath, Buffer.from(data, "base64"), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Encoding": "base64"
        }
      });
    } catch (err) {
      console.error(err);
    }

    try {
      const SQSparams = {
        MessageBody: JSON.stringify([new_values, params]),
        QueueUrl: requestQueue,
        DelaySeconds: 10,
        MessageAttributes: {
          Process: {
            DataType: "String",
            StringValue: "Pte_Done"
          },
          TenantId: {
            DataType: "String",
            StringValue: tenantId
          },
          Stage: {
            DataType: "String",
            StringValue: stage
          }
        }
      };
      const sqs = new SQS({ region: REGION });
      return sqs.sendMessage(SQSparams);
    } catch (e) {
      console.log(e);
    }
  }
}





module.exports.queryPTE = queryPTE;
module.exports.processPTE = processPTE;

