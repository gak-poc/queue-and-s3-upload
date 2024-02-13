const { SQS } = require("@aws-sdk/client-sqs");
const SITE_URL = "https://englishtest.duolingo.com/login";
const axios = require("axios");
const dayjs = require('dayjs')
const { REGION } = require("./config");

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const queryDuolingo = async (browser_handler, username, password, trf_number) => {
  console.log("NEW DuoLingo query", new Date(), trf_number);
  const result = [];
  const pages = await browser_handler.browser.pages();
  if (pages.length === 0) {
    pages.push(await browser_handler.browser.newPage());
  }
  const page = pages.find(d => d.url().match(/(\w+\.duolingo\.com|about:blank)/)) || (await browser_handler.browser.newPage());
  page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36");
  await page.setViewport({
    width: 1400,
    height: 1300,
    deviceScaleFactor: 1,
  });

  const url = await page.url();
  console.log('DuoLingo', url)

  const login = async (username, password) => {
    console.log('DuoLingo:login', username, password)
    try {
      await page.waitForSelector('input[type="password"]', { timeout: 5000 })
      await page.type('input[type="text"]', username);
      await page.type('input[type="password"]', password);
      await Promise.all([
        page.click('[type="submit"]'),
        page.waitForNavigation({ waitUntil: 'networkidle0' })]
      )
    } catch (e) {
      console.log('DuoLingo: login_issue', e);
    }
    console.log('DuoLingo: login complete', new Date());
  }

  const capture = async (trf_number) => {
    console.log('DuoLingo: capture', trf_number)
    const inputPlaceholder = "Search by Name or Email";
    const inputSelector = `input[placeholder="${inputPlaceholder}"]`;
    await page.waitForSelector(inputSelector, { visible: true });
    await page.type(inputSelector, trf_number);
    await page.click("button[type=submit]");
    await page.waitForTimeout(2000);

    const elementHandle = await page.$x(
      '//a[text()="View" and contains(@href,"certs")]'
    );
    const certificateURI = await page.evaluate(anchor => anchor.getAttribute('href'), elementHandle[0])
    await page.goto(certificateURI, { waitUntil: "networkidle2" });
    await timeout(2000);
    const xp = `/html/body/div[2]/div/div/div[2]`;
    await page.waitForXPath(xp);
    
    const [printableArea] = await page.$x(xp);
    const bounding_box = await printableArea.boundingBox();
    
    const image = await page.screenshot({
      omitBackground: true,
      clip: bounding_box
    });
    result.push(image);
    
  };

  if (url.match(/(w+\.duolingo\.com|about:blank)/)) {
    await page.setRequestInterception(true);
    page.on('request', async request => {
      if (request.url().match(/(www.google-analytics.com|www.googletagmanager.com|geolocation.onetrust.com|cdn.cookielaw.org|auto_tracking_properties)/)) {
        request.abort();
      } else {
        request.continue();
      }
    });
    page.on('requestfinished', async (request) => {
      if (request.url().match(/englishtest.duolingo.com\/api\/dashboard\/show/)) {
        let responseBody;
        if (request.redirectChain().length === 0) {
          const response = await request.response();
          // Because body can only be accessed for non-redirect responses.
          responseBody = JSON.parse((await response.buffer()).toString());
          if (Array.isArray(responseBody.table_rows) && responseBody.table_rows.length > 0) {
            if (responseBody.table_rows[0].email === trf_number) {
              result.push(responseBody.table_rows[0]);
            }
          }
        }
      }
    });

    console.log('DuoLingo: SITE_URL', SITE_URL)
    await page.goto(SITE_URL, { waitUntil: 'networkidle2' });
    console.log('DuoLingo: Query page open', new Date(), url.match(/englishtest.duolingo.com\/dashboard/));
    if (!url.match(/englishtest.duolingo.com\/dashboard/)) {
      await login(username, password);
    }
    
    await capture(trf_number);
    await page.goto('https://englishtest.duolingo.com/logout', { waitUntil: 'networkidle2' });
    
    await timeout(1000);
    await page.close();
  } else {
    throw Error(`DuoLingo: Processing...${url}`);
  }
  return result;
};

const processDuolingo = async (
  result,
  params,
  tenantId,
  requestQueue,
  stage
) => {
  console.log("DuoLingo: process", result.length);
  if (Array.isArray(result) && result.length === 2) {
    const [studentDetails,_,duolingo_image] = result;
    const keys = ['email','country', 'subscores', 'test_taken_datetime', 'given_names', 'surnames', 'birthdate', 'overall_score'];
    const new_values = keys.filter(key => studentDetails[key]).reduce((pv, key) => {
      if (['birthdate'].indexOf(key) > -1) {
        pv[key] = dayjs(studentDetails[key]).format('YYYY-MM-DD')
      } else if (['test_taken_datetime'].indexOf(key) > -1) {
        pv[key] = dayjs.unix(studentDetails[key]/1000).format('YYYY-MM-DD')
      } else {
        pv[key] = studentDetails[key];
      }
      return pv;
    }, {});
    // console.log(new_values, studentDetails, duolingo_image)
    try {
      await axios.put(params.preSignedFilePath, duolingo_image, {
        headers: {
          "Content-Type": "application/png",
          "Content-Encoding": "base64",
        },
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
            StringValue: "duolingo_Done",
          },
          TenantId: {
            DataType: "String",
            StringValue: tenantId,
          },
          Stage: {
            DataType: "String",
            StringValue: stage,
          },
        },
      };
      const sqs = new SQS({ region: REGION });
      return sqs.sendMessage(SQSparams);
    } catch (e) {
      console.log(e);
    }
  }
};

module.exports.queryDuolingo = queryDuolingo;
module.exports.processDuolingo = processDuolingo;
