const { SQS } = require("@aws-sdk/client-sqs");
const SITE_URL = "https://results.neco.gov.ng/";
const axios = require("axios");
const dayjs = require("dayjs");
const { REGION } = require("./config");

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const queryNeco = async (
  browser_handler,
  exam_year,
  exam_type,
  reg_no,
  token
) => {
  console.log("NEW Neco query", new Date(), token);
  const result = [];
  const pages = await browser_handler.browser.pages();
  if (pages.length === 0) {
    pages.push(await browser_handler.browser.newPage());
  }
  const page =
    pages.find((d) =>
      d.url().match(/(\w+\.results.neco.gov\.ng|about:blank)/)
    ) || (await browser_handler.browser.newPage());
  page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36"
  );
  await page.setViewport({
    width: 1400,
    height: 1300,
    deviceScaleFactor: 1,
  });

  const url = await page.url();
  console.log("Neco", url);

  const login = async (exam_year, exam_type, reg_no, token) => {
    console.log("Neco:Check Result ", exam_year, exam_type, reg_no, token);
    try {
      await page.waitForSelector("//select[@name='exam_year']", {
        timeout: 5000,
      });
      const selectElementExamYear = await page.$x(
        "//select[@name='exam_year']"
      );
      await page.evaluate((select) => {
        select.value = exam_year;
      }, selectElementExamYear[0]);
      await selectElementExamYear[0].evaluate((element) => {
        const event = new Event("change", { bubbles: true });
        element.dispatchEvent(event);
      });

      const selectElementExamType = await page.$x(
        "//select[@name='exam_type']"
      );
      await page.evaluate((select) => {
        select.value = exam_type;
      }, selectElementExamType[0]);
      await selectElementExamType[0].evaluate((element) => {
        const event = new Event("change", { bubbles: true });
        element.dispatchEvent(event);
      });

      await page.type('input[type="token"]', token);
      await page.type('input[type="reg_number"]', reg_no);
      await Promise.all([
        page.click('[type="submit"]'),
        page.waitForNavigation({ waitUntil: "networkidle0" }),
      ]);
    } catch (e) {
      console.log("Neco: login_issue", e);
    }
    console.log("Neco: login complete", new Date());

    console.log("Neco: Result", reg_no);
    const element = await page.$x(
      "//*[contains(text(), 'National Examinations Council (NECO)')]"
    );
    if (element.length > 0) {
      const text = await page.evaluate((el) => el.textContent, element[0]);
      console.log("Navigate to NECO Result Page:", text);

      //wait for the result certificate examination photocard xpath
      const xp = `//*[@id="app"]/div[2]/section/div/div[2]`;
      await page.waitForXPath(xp);

      const [printableArea] = await page.$x(xp);
      const bounding_box = await printableArea.boundingBox();

      const image = await page.screenshot({
        omitBackground: true,
        clip: bounding_box,
      });
      result.push(image);
    } else {
      console.log("Navigation to NECO reslt page not happening.");
    }
  };
  if (url.match(/(w+\.results.neco.gov.\.ng|about:blank)/)) {
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      if (
        request
          .url()
          .match(
            /(www.google-analytics.com|www.googletagmanager.com|geolocation.onetrust.com|cdn.cookielaw.org|auto_tracking_properties)/
          )
      ) {
        request.abort();
      } else {
        request.continue();
      }
    });
    page.on("requestfinished", async (request) => {
      if (
        request.url().match(/necoproductions.com:8095\/api\/results\/check/)
      ) {
        let responseBody;
        if (request.redirectChain().length === 0) {
          const response = await request.response();
          // Because body can only be accessed for non-redirect responses.
          responseBody = JSON.parse((await response.buffer()).toString());
          if (responseBody.reg_number === reg_no) {
            result.push(responseBody);
          }
        }
      }
    });

    console.log("NECO: SITE_URL", SITE_URL);
    await page.goto(SITE_URL, { waitUntil: "networkidle2" });
    console.log(
      "NECO: Query page open",
      new Date(),
      url.match(/results.neco.gov.ng/)
    );
    if (url.match(/results.neco.gov.ng/)) {
      await login(exam_year, exam_type, reg_no, token);
    }
    // verification: After retrieving the data whether to press the back button and close the page
  } else {
    throw Error(`NECO: Processing...${url}`);
  }
  return result;
};

const processNeco = async (result, params, tenantId, requestQueue, stage) => {
  //  console.log("Neco: process", result.length);
  if (Array.isArray(result) && result.length === 2) {
    const [studentResultDetails, _, neco_cert_image] = result;
    const keys = [
      "id",
      "dob",
      "gender",
      "barcode",
      "passport",
      "reason",
      "debt",
      "biometrics",
      "full_name",
      "reg_number",
      "candidate_number",
      "exam_year",
      "exam_type",
      "centre_code",
      "centre_name",
      "sub1_name",
      "sub2_name",
      "sub3_name",
      "sub4_name",
      "sub5_name",
      "sub6_name",
      "sub7_name",
      "sub8_name",
      "sub9_name",
      "sub1_grade",
      "sub2_grade",
      "sub3_grade",
      "sub4_grade",
      "sub5_grade",
      "sub6_grade",
      "sub7_grade",
      "sub8_grade",
      "sub9_grade",
      "sub1_remark",
      "sub2_remark",
      "sub3_remark",
      "sub4_remark",
      "sub5_remark",
      "sub6_remark",
      "sub7_remark",
      "sub8_remark",
      "sub9_remark",
      "num_of_sub",
      "show_photo",
      "show_dob",
    ];

    const new_values = Object.keys(studentDetails)
      .filter((key) => keys.includes(key) && studentResultDetails[key])
      .reduce((pv, key) => {
        if (key === "dob") {
          pv[key] = dayjs(studentResultDetails[key]).format("YYYY-MM-DD");
        } else {
          pv[key] = studentResultDetails[key];
        }
        return pv;
      }, {});

    try {
      await axios.put(params.preSignedFilePath, neco_cert_image, {
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
            StringValue: "Neco_Done",
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

module.exports.queryNeco = queryNeco;
module.exports.processNeco = processNeco;
