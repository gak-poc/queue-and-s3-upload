const AWS = require('aws-sdk');const fs = require('fs');const path = require('path');
Feature('S3 File Upload');
const bucketName = 'tpengages3';const s3URI = 's3://arn:aws:s3:us-east-1:218134119811:accesspoint/tpengages3';
const arn = 'arn:aws:s3:us-east-1:218134119811:accesspoint/tpengages3';
Scenario('Upload a file to S3', async ({ I }) => {  
  const s3 = new AWS.S3({    endpoint: s3URI,    accessKeyId: process.env.AWS_ACCESS_KEY_ID,    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,  });
  const filePaths = {    image: 'path/to/image.jpg',    pdf: 'path/to/document.pdf',  };
  
  // Upload the image  
  const imageKey = `uploads/${path.basename(filePaths.image)}`;  
  const imageStream = fs.createReadStream(filePaths.image);  
  await s3.upload({    Bucket: bucketName,    Key: imageKey,    Body: imageStream,  }).promise();
  
  // Upload the PDF file  
  const pdfKey = `uploads/${path.basename(filePaths.pdf)}`;  
  const pdfStream = fs.createReadStream(filePaths.pdf);  
  await s3.upload({    Bucket: bucketName,    Key: pdfKey,    Body: pdfStream,  }).promise();
  
  // Verify that the files were uploaded successfully  
  const imageExists = await s3.headObject({    Bucket: bucketName,    Key: imageKey,  }).promise().then(() => true).catch(() => false);
  const pdfExists = await s3.headObject({    Bucket: bucketName,    Key: pdfKey,  }).promise().then(() => true).catch(() => false);
  if (imageExists && pdfExists)
  {    I.say('Files uploaded successfully!');  }
  else {    throw new Error('Failed to upload files to S3');  }});
