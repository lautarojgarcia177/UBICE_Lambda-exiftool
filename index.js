const { exiftool } = require("exiftool-vendored");
const { padStart } = require("lodash");
const AWS = require("aws-sdk");
const s3 = new AWS.S3();
const rekognitionClient = new AWS.Rekognition({
  region: 'us-east-1'
});
const fs = require("fs");

async function writeMetadataOnImage(imagePath, numbers) {
  let unrepeatedNumbers = Array.from(new Set(numbers));
  if (!unrepeatedNumbers.length) {
    unrepeatedNumbers = ["#"];
  } else {
    unrepeatedNumbers = unrepeatedNumbers.map((number) =>
      padStart(String(number), 5, "0")
    );
  }
  const { Keywords } = await exiftool.read(imagePath);
  await exiftool.write(imagePath, { Keywords: [...unrepeatedNumbers] }, [
    "-overwrite_original",
  ]);
}

const useRegex = (input) => {
  let regex = /^[0-9]+$/i;
  return regex.test(input);
};

async function deleteObjectFromS3(bucketName, objectKey) {
  try {
    await s3
      .deleteObject({
        Bucket: bucketName,
        Key: objectKey,
      })
      .promise();
    console.log(`Deleted object ${objectKey} from bucket ${bucketName}`);
  } catch (err) {
    console.error(
      `Error deleting object ${objectKey} from bucket ${bucketName}: `,
      err
    );
  }
}

async function rekognize(imageBytes) {
  try {
    const params = {
      Image: {
        Bytes: imageBytes,
      },
      Filters: {
        WordFilter: {
          MinConfidence: 95,
        },
      },
    };
    const commandResult = await rekognitionClient.detectText(params).promise();
    let numbersArray = commandResult.TextDetections.filter((textDetection) =>
      useRegex(textDetection.DetectedText)
    ).map((textDetection) => textDetection.DetectedText);
    numbersArray = Array.from(new Set(numbersArray));
    if (!numbersArray.length) {
      numbersArray = ["#"];
    } else {
      numbersArray = numbersArray.map((number) =>
        padStart(String(number), 5, "0")
      );
    }
    return numbersArray;
  } catch (err) {
    console.error("Error rekognizing an image: ", err);
    // throw new Error("Error rekognizing an image: " + err);
  }
}

exports.handler = async (event) => {
  let response = null;
  const objectKey = event.Records[0].s3.object.key;
  try {
    // Obtain the uploaded photo
    response = await s3
      .getObject({ Bucket: process.env.UPLOAD_BUCKET_NAME, Key: objectKey })
      .promise();
  } catch (err) {
    console.error("Error obtaining S3 object: ", err);
  }
  // Obtain the numbers in the photo
  const numbersArray = await rekognize(response.Body);
  console.log('Obtained numbers: ', numbersArray)
  let imageFile;
  const imageFilePath = "/tmp/" + objectKey;
  console.log('Image File Path: ', numbersArray)
  try {
    // label the image
    fs.writeFileSync(imageFilePath, response.Body);
    await writeMetadataOnImage(imageFilePath, numbersArray);
    // Delete the uploaded photo from upload bucket
    await deleteObjectFromS3(process.env.UPLOAD_BUCKET_NAME, objectKey);
  } catch (err) {
    console.error("Error writing on image metadata with exiftool: ", err);
  }
  try {
    const imageFile = fs.readFileSync(imageFilePath);
    await s3
      .putObject({
        Bucket: process.env.DESTINATION_BUCKET_NAME,
        Key: objectKey,
        Body: imageFile,
        ContentType: "image/jpeg",
      })
      .promise();
    fs.unlinkSync(imageFilePath);
  } catch (err) {
    console.error("Error uploading on the destination bucket: ", err);
  }
};