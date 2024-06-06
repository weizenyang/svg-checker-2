import sharp from 'sharp'
import fs from 'fs'

async function mergeImages(image1, image2, outputFile) {
  try {
      const metadata1 = await sharp(image1).metadata();
      const metadata2 = await sharp(image2).metadata();

      const width = Math.max(metadata1.width, metadata2.width);
      const height = metadata1.height;

      const mergedImage = await sharp({
      create: {
          width,
          height,
          channels: metadata1.channels,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
      })
      .composite([
          { input: image1, top: 0, left: 0},
          { input: image2, top: 0, left: 0, blend: 'over' }, // Add 'blend: 'over''
        ])
      .toFile(outputFile);

      console.log(`Merged images into: ${outputFile}`);
  } catch (error) {
      console.error('Error merging images:', error);
  }
}

// Replace with your image paths and desired output filename
const image1Path = 'path/to/image1.jpg';
const image2Path = 'path/to/image2.png';
const outputFile = 'merged_image.jpg';

//mergeImages(image1Path, image2Path, outputFile);

//Compare Images based on frequency of occuring characters
function getCharacterMatchPercentage(string1, string2) {
    // Count character frequencies
    const charFreq1 = new Map();
    for (const char of string1) {
      const count = charFreq1.get(char) || 0;
      charFreq1.set(char, count + 1);
    }
  
    const charFreq2 = new Map();
    for (const char of string2) {
      const count = charFreq2.get(char) || 0;
      charFreq2.set(char, count + 1);
    }
  
    // Get total characters (union of both sets)
    const allChars = new Set([...string1, ...string2]);
    const totalChars = allChars.size;
  
    // Calculate absolute difference in frequencies for each character
    let diffSum = 0;
    for (const char of allChars) {
      const count1 = charFreq1.get(char) || 0;
      const count2 = charFreq2.get(char) || 0;
      diffSum += Math.abs(count1 - count2);
    }
  
    // Calculate percentage difference
    const percentageDifference = (diffSum / totalChars) * 100;
  
    return percentageDifference;
  }

  var baseAssetNames = [];
  var dimensionsAssetNames = [];
  var matchingDimensionNames = [];

  //Standard Dimensions
  const outputFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Standard Beige Background Dimensions/4k"
  const dimensionsFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Dimensions/Standard/4096"
  const baseFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Standard/Standard Beige Background Doorway/4k"
  
  // //Townhouse Dimensions
  // const outputFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Townhouse Beige Background Dimensions"
  // const dimensionsFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Dimensions/Townhouse"
  // const baseFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Townhouse/Townhouse Beige Background Doorway"

  //Townhouse Car
  // const outputFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Townhouse Beige Background Cars"
  // const dimensionsFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Cars/Townhouse"
  // const baseFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Townhouse/Townhouse Beige Background Doorway/G"

  //Standard Car
  // const outputFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Standard Beige Background Cars/4k"
  // const dimensionsFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Cars/Standard/4k"
  // const baseFolderPath = "/Users/EdmundWei/Downloads/Premium 8K - Beige/Standard/Standard Beige Background Doorway/G"

    baseAssetNames = fs.readdirSync(baseFolderPath);
    dimensionsAssetNames = fs.readdirSync(dimensionsFolderPath);

    for(let i = 0; i < baseAssetNames.length; i++){
        let tempNames;
        tempNames = baseAssetNames[i].replace("_S1", "")
        tempNames = baseAssetNames[i].replace("_S2", "")
        let currentPercentage = 100;
        matchingDimensionNames.push("Init")
        dimensionsAssetNames.forEach((j)=>{
            console.log(tempNames + " " + j)
            console.log(currentPercentage + " " + getCharacterMatchPercentage(tempNames, j))
            
            const matchPercentage = getCharacterMatchPercentage(tempNames, j);
            if(matchPercentage < currentPercentage){
                currentPercentage = matchPercentage
                matchingDimensionNames[i] = j;
            }
            
        })
    }

    for(let i = 0; i < baseAssetNames.length; i++){
        const outputFilePath = outputFolderPath+ "/" + baseAssetNames[i].split(".")[0] + "." + baseAssetNames[i].split(".")[1] 
        const dimensionsFilePath = dimensionsFolderPath + "/" + matchingDimensionNames[i] 
        const baseFilePath = baseFolderPath + "/" + baseAssetNames[i]
        mergeImages(baseFilePath, dimensionsFilePath, outputFilePath)
        console.log(baseAssetNames[i] + " " + matchingDimensionNames[i])
    }

// const percentageMatch = getCharacterMatchPercentage(string1, string2);

// console.log(`Character match percentage: ${percentageMatch}%`);