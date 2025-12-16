# SVG Checker 2 - Asset Delivery API Specification

## Overview

This document describes the API format for delivering 3D models, camera positions, and 360-degree images to the SVG Checker 2 application. The application automatically fetches assets from a server endpoint on page load based on a project key.

## Base URL

```
http://localhost:9234
```

## Endpoints

### Primary Endpoint: Get Project Assets

**Endpoint:** `GET /api/project/{projectKey}`

**Description:** Fetches all assets (models, camera CSV, and images) for a given project in a single request.

**URL Parameters:**
- `projectKey` (string, required): Unique identifier for the project. Can be obtained from URL parameters `?project=`, `?key=`, or `?id=` in the client application.

**Response Format:**
```json
{
  "models": [
    {
      "modelName": "model_360-collision_a_s_1b_c1_0.glb",
      "data": "<base64-encoded-string | ArrayBuffer | Uint8Array>"
    }
  ],
  "cameraCSV": {
    "csvName": "csv_camera_a_s_1b_c1_s1.csv",
    "data": "<string | ArrayBuffer | Uint8Array>"
  },
  "images": [
    {
      "imageName": "a_s_1b_c1_s1.jpg",
      "data": "<base64-encoded-string | ArrayBuffer | Uint8Array>",
      "mimeType": "image/jpeg"
    }
  ]
}
```

**Response Status Codes:**
- `200 OK`: Successfully retrieved project assets
- `404 Not Found`: Project not found
- `500 Internal Server Error`: Server error

**Example Request:**
```bash
curl http://localhost:9234/api/project/my-project-key
```

**Example Response:**
```json
{
  "models": [
    {
      "modelName": "room_model.glb",
      "data": "glTF2.0...base64encoded..."
    }
  ],
  "cameraCSV": {
    "csvName": "cameras.csv",
    "data": "name,x,y,z,rot_x,rot_y,rot_z\ncamera1,0,0,0,0,0,0"
  },
  "images": [
    {
      "imageName": "view_001.jpg",
      "data": "/9j/4AAQSkZJRgABAQEAYABgAAD...",
      "mimeType": "image/jpeg"
    }
  ]
}
```

### Legacy Endpoints (Fallback)

If the primary endpoint fails, the client will attempt these legacy endpoints:

#### Get Models

**Endpoint:** `GET /model`

**Response Format:**
```json
{
  "models": [
    {
      "modelName": "model.glb",
      "data": "<base64-encoded-string | ArrayBuffer | Uint8Array>"
    }
  ]
}
```

#### Get Camera CSV

**Endpoint:** `GET /camera-csv`

**Response Format:**
```json
{
  "csvName": "cameras.csv",
  "data": "<string | ArrayBuffer | Uint8Array>"
}
```

## Data Format Specifications

### Models Array

Each model object represents a 3D model file (typically GLB format).

**Required Fields:**
- `modelName` (string): Filename of the model (e.g., `"model.glb"`)
- `data` (string | ArrayBuffer | Uint8Array): Binary data of the model file

**Supported Data Formats:**
1. **Base64-encoded string**: `"glTF2.0...base64encoded..."`
2. **ArrayBuffer**: Raw binary data
3. **Uint8Array**: Typed array of bytes

**Example:**
```json
{
  "modelName": "room_360-collision_a_s_1b_c1_0.glb",
  "data": "glTF2.0\u0000\u0000\u0000\u0000..."
}
```

### Camera CSV Object

Contains camera position and rotation data in CSV format.

**Required Fields:**
- `csvName` (string): Filename of the CSV file (e.g., `"cameras.csv"`)
- `data` (string | ArrayBuffer | Uint8Array): CSV content

**CSV Format:**
```
name,x,y,z,rot_x,rot_y,rot_z
camera_001,0.0,1.5,0.0,0,0,0
camera_002,5.0,1.5,0.0,0,90,0
```

**Column Definitions:**
- `name`: Unique identifier for the camera/cone
- `x`: X position (float)
- `y`: Y position (float)
- `z`: Z position (float)
- `rot_x`: X rotation in degrees (float)
- `rot_y`: Y rotation in degrees (float)
- `rot_z`: Z rotation in degrees (float)

**Note:** The client application transforms coordinates:
- Position: `(x, -z, y)` → `(x, y, z)` in Three.js
- Rotation: Uses `rot_y` as the primary rotation axis

**Supported Data Formats:**
1. **String**: Plain CSV text
2. **ArrayBuffer**: Binary data containing CSV text
3. **Uint8Array**: Typed array containing CSV bytes

**Example:**
```json
{
  "csvName": "csv_camera_a_s_1b_c1_s1.csv",
  "data": "name,x,y,z,rot_x,rot_y,rot_z\ncamera1,0,0,0,0,0,0"
}
```

### Images Array

Each image object represents a 360-degree equirectangular image.

**Required Fields:**
- `imageName` (string): Filename of the image (e.g., `"a_s_1b_c1_s1.jpg"`)
- `data` (string | ArrayBuffer | Uint8Array): Image data
- `mimeType` (string): MIME type (e.g., `"image/jpeg"`, `"image/png"`)

**Supported Data Formats:**
1. **Data URL string**: `"data:image/jpeg;base64,/9j/4AAQSkZJRg..."` (starts with `data:`)
2. **Base64-encoded string**: `"/9j/4AAQSkZJRg..."` (will be converted to data URL)
3. **ArrayBuffer**: Raw binary image data
4. **Uint8Array**: Typed array of image bytes

**Image Naming Convention:**
- Images are matched to camera positions by name
- Example: Image `"a_s_1b_c1_s1.jpg"` corresponds to camera `"a_s_1b_c1_s1"`
- The client uses `imageManager.findImageByName()` to match images to cameras

**Example:**
```json
{
  "imageName": "a_s_1b_c1_s1.jpg",
  "data": "/9j/4AAQSkZJRgABAQEAYABgAAD...",
  "mimeType": "image/jpeg"
}
```

## Client Behavior

### Project Key Resolution

The client determines the project key from URL parameters in this order:
1. `?project={key}`
2. `?key={key}`
3. `?id={key}`
4. Default: `"default"`

**Example URLs:**
```
http://localhost:3000/roomscale-4?project=my-project
http://localhost:3000/roomscale-4?key=my-project
http://localhost:3000/roomscale-4?id=my-project
http://localhost:3000/roomscale-4  (uses "default")
```

### Loading Sequence

1. **Page Load**: Client extracts project key from URL
2. **Fetch Assets**: Calls `GET /api/project/{projectKey}`
3. **Process Models**: Loads each GLB model into Three.js scene
4. **Process CSV**: Creates camera markers/cones from CSV data
5. **Index Images**: Adds images to `imageManager` for on-demand loading
6. **Fallback**: If primary endpoint fails, tries legacy endpoints

### Error Handling

- If primary endpoint fails, client attempts legacy endpoints
- If all endpoints fail, client logs error and continues (user can manually upload files)
- Individual asset loading errors are logged but don't stop the process

## Implementation Examples

### Node.js/Express Server

```javascript
const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = 9234;

// Serve project assets
app.get('/api/project/:projectKey', async (req, res) => {
  const { projectKey } = req.params;
  
  try {
    const projectDir = path.join(__dirname, 'projects', projectKey);
    
    // Load models
    const modelFiles = await fs.readdir(path.join(projectDir, 'models'));
    const models = await Promise.all(
      modelFiles.map(async (file) => {
        const data = await fs.readFile(path.join(projectDir, 'models', file));
        return {
          modelName: file,
          data: data.toString('base64') // or send as Buffer
        };
      })
    );
    
    // Load CSV
    const csvPath = path.join(projectDir, 'cameras.csv');
    const csvData = await fs.readFile(csvPath, 'utf-8');
    const cameraCSV = {
      csvName: 'cameras.csv',
      data: csvData
    };
    
    // Load images
    const imageFiles = await fs.readdir(path.join(projectDir, 'images'));
    const images = await Promise.all(
      imageFiles.map(async (file) => {
        const data = await fs.readFile(path.join(projectDir, 'images', file));
        return {
          imageName: file,
          data: data.toString('base64'),
          mimeType: `image/${path.extname(file).slice(1)}`
        };
      })
    );
    
    res.json({ models, cameraCSV, images });
  } catch (error) {
    res.status(404).json({ error: 'Project not found' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

### Python/Flask Server

```python
from flask import Flask, jsonify, send_file
import os
import base64

app = Flask(__name__)
BASE_DIR = '/path/to/projects'

@app.route('/api/project/<project_key>')
def get_project(project_key):
    project_dir = os.path.join(BASE_DIR, project_key)
    
    if not os.path.exists(project_dir):
        return jsonify({'error': 'Project not found'}), 404
    
    # Load models
    models_dir = os.path.join(project_dir, 'models')
    models = []
    if os.path.exists(models_dir):
        for filename in os.listdir(models_dir):
            if filename.endswith('.glb'):
                with open(os.path.join(models_dir, filename), 'rb') as f:
                    data = base64.b64encode(f.read()).decode('utf-8')
                    models.append({
                        'modelName': filename,
                        'data': data
                    })
    
    # Load CSV
    csv_path = os.path.join(project_dir, 'cameras.csv')
    camera_csv = None
    if os.path.exists(csv_path):
        with open(csv_path, 'r') as f:
            camera_csv = {
                'csvName': 'cameras.csv',
                'data': f.read()
            }
    
    # Load images
    images_dir = os.path.join(project_dir, 'images')
    images = []
    if os.path.exists(images_dir):
        for filename in os.listdir(images_dir):
            if filename.lower().endswith(('.jpg', '.jpeg', '.png')):
                with open(os.path.join(images_dir, filename), 'rb') as f:
                    data = base64.b64encode(f.read()).decode('utf-8')
                    mime_type = 'image/jpeg' if filename.lower().endswith('.jpg') else 'image/png'
                    images.append({
                        'imageName': filename,
                        'data': data,
                        'mimeType': mime_type
                    })
    
    return jsonify({
        'models': models,
        'cameraCSV': camera_csv,
        'images': images
    })

if __name__ == '__main__':
    app.run(host='localhost', port=9234)
```

### Project Directory Structure

```
projects/
  └── my-project-key/
      ├── models/
      │   ├── model_360-collision_a_s_1b_c1_0.glb
      │   └── model_360-collision_a_s_1b_c1_1.glb
      ├── cameras.csv
      └── images/
          ├── a_s_1b_c1_s1.jpg
          ├── a_s_1b_c1_s2.jpg
          └── a_s_1b_c1_s3.jpg
```

## Notes

1. **Image Loading**: Images are indexed but not compressed during initial load. Compression happens on-demand when images are viewed.

2. **Coordinate System**: The client uses Three.js coordinate system (Y-up). CSV coordinates are transformed accordingly.

3. **File Size**: For large files, consider:
   - Using ArrayBuffer/Uint8Array instead of base64 strings (reduces size by ~33%)
   - Implementing compression/gzip on the server
   - Using chunked loading for very large projects

4. **CORS**: Ensure your server allows CORS requests from the client origin.

5. **Performance**: The client processes assets sequentially. For better performance, consider:
   - Parallel processing of models
   - Lazy loading of images
   - Progressive loading of large assets

## Version History

- **v1.0**: Initial specification with primary endpoint and legacy fallback support

