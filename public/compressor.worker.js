// compressor.worker.js

self.onmessage = async (e) => {
    const { id, imageBitmap, quality } = e.data;
    // 1) Create offscreen canvas matching dimensions
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx    = canvas.getContext("2d");
  
    // 2) Draw the frame
    ctx.drawImage(imageBitmap, 0, 0);
  
    // 3) Compress to JPEG
    //    convertToBlob is promise‐based and much faster than toDataURL
    const blob = await canvas.convertToBlob({
      type:    "image/jpeg",
      quality: quality    // e.g. 0.8
    });
    const buffer = await blob.arrayBuffer();
  
    // 4) Post back with transferable buffer
    self.postMessage({ id, buffer }, [buffer]);
  };
  