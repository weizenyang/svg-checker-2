# SVG Checker 2 - Asset Delivery API Specification

## Overview

This document describes the API format for delivering 3D models, camera positions, and 360-degree images to the SVG Checker 2 application. The application automatically fetches assets from a server endpoint on page load based on a project key.

The application operates in two modes:
- **Roomscale Mode** (`/roomscale-4`): Used when loading model, CSV, or image files. Focuses on 3D models, camera positions, and 360-degree images.
- **Refactored Mode** (`/refactored`): Used when loading SVG files. Focuses on SVG floorplates and unit floorplans.

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
  "mode": "roomscale-4",
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
    },
    {
      "imageName": "backplate_image_tower-floorplate_a_01.svg",
      "data": "<base64-encoded-string | ArrayBuffer | Uint8Array>",
      "mimeType": "image/svg+xml"
    }
  ],
  "unitFloorplans": [
    {
      "imageName": "unit_floorplan_01.svg",
      "data": "<base64-encoded-string | ArrayBuffer | Uint8Array>",
      "mimeType": "image/svg+xml"
    }
  ]
}
```

**Response Fields by Mode:**
- **Mode Field** (`mode`): Indicates which application mode to use. Possible values:
  - `"roomscale-4"`: Use Roomscale Mode (3D models, cameras, 360 images)
  - `"refactored"`: Use Refactored Mode (SVG floorplates and unit floorplans)

- **Roomscale Mode (`roomscale-4`)** - Primary fields:
  - `models` (array, required): 3D model files (GLB format)
  - `cameraCSV` (object, required): Camera position and rotation data
  - `images` (array, required): 360-degree equirectangular images (JPG/PNG)
  - `unitFloorplans` (array, optional): Unit floorplan SVGs (may be empty)

- **Refactored Mode (`refactored`)** - Primary fields:
  - `images` (array, required): SVG floorplate files from parent folder
  - `unitFloorplans` (array, required): Unit floorplan SVGs from `backplate_image_floorplan_property_unit` folder
  - `models` (array, optional): May be empty or contain models
  - `cameraCSV` (object, optional): May be null or empty

**Response Status Codes:**
- `200 OK`: Successfully retrieved project assets
- `404 Not Found`: Project not found
- `500 Internal Server Error`: Server error

**Example Request:**
```bash
curl http://localhost:9234/api/project/my-project-key
```

**Example Response (Roomscale Mode):**
```json
{
  "mode": "roomscale-4",
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
  ],
  "unitFloorplans": []
}
```

**Example Response (Refactored Mode):**
```json
{
  "mode": "refactored",
  "models": [],
  "cameraCSV": null,
  "images": [
    {
      "imageName": "backplate_image_tower-floorplate_a_01.svg",
      "data": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmci...",
      "mimeType": "image/svg+xml"
    },
    {
      "imageName": "backplate_image_tower-floorplate_a_01.png/webp",
      "data": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmci...",
      "mimeType": "image/svg+xml"
    }
  ],
  "unitFloorplans": [
    {
      "imageName": "unit_floorplan_01.png/webp",
      "data": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmci...",
      "mimeType": "image/svg+xml"
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

Each image object represents a 360-degree equirectangular image or SVG file from the main image folders.

**Required Fields:**
- `imageName` (string): Filename of the image (e.g., `"a_s_1b_c1_s1.jpg"`, `"backplate_image_tower-floorplate_a_01.svg"`)
- `data` (string | ArrayBuffer | Uint8Array): Image data
- `mimeType` (string): MIME type (e.g., `"image/jpeg"`, `"image/png"`, `"image/svg+xml"`)

**Supported File Types:**
- `.jpg`, `.jpeg` - JPEG images (MIME: `"image/jpeg"`)
- `.png` - PNG images (MIME: `"image/png"`)
- `.svg` - SVG vector graphics (MIME: `"image/svg+xml"`)

**Supported Data Formats:**
1. **Data URL string**: `"data:image/jpeg;base64,/9j/4AAQSkZJRg..."` (starts with `data:`)
2. **Base64-encoded string**: `"/9j/4AAQSkZJRg..."` (will be converted to data URL)
3. **ArrayBuffer**: Raw binary image data
4. **Uint8Array**: Typed array of image bytes

**Image Naming Convention:**
- Images are matched to camera positions by name
- Example: Image `"a_s_1b_c1_s1.jpg"` corresponds to camera `"a_s_1b_c1_s1"`
- The client uses `imageManager.findImageByName()` to match images to cameras

**SVG File Handling:**
- When an SVG file is selected, the application searches the parent folder structure
- All SVG and image files from the parent folder and subfolders are loaded into the `images` array
- Folders containing "ss" in their name are ignored (case-insensitive)
- Example: Selecting `backplate_image_tower-floorplate/a/svgs/file.svg` loads all SVGs and images from `backplate_image_tower-floorplate/`
- Additionally, the application searches for `backplate_image_floorplan_property_unit` folder in the `FOR_THE_APP` directory
- All images and SVGs from `backplate_image_floorplan_property_unit` are loaded into the separate `unitFloorplans` array

**Examples:**
```json
{
  "imageName": "a_s_1b_c1_s1.jpg",
  "data": "/9j/4AAQSkZJRgABAQEAYABgAAD...",
  "mimeType": "image/jpeg"
}
```

```json
{
  "imageName": "backplate_image_tower-floorplate_a_01.svg",
  "data": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmci...",
  "mimeType": "image/svg+xml"
}
```

## Client Behavior

### Project Key Resolution

The client determines the project key from URL parameters in this order:
1. `?project={key}`
2. `?key={key}`
3. `?id={key}`
4. Default: `"default"`

### Mode Detection

The application mode is determined by the URL route:
- **Roomscale Mode**: `/roomscale-4` - Used when loading model, CSV, or image files
- **Refactored Mode**: `/refactored` - Used when loading SVG files

The API response also includes a `mode` field that indicates which mode the client should use:
- `"roomscale-4"`: Client should use Roomscale Mode and primarily use `models`, `cameraCSV`, and `images` fields
- `"refactored"`: Client should use Refactored Mode and primarily use `images` and `unitFloorplans` fields

**Example URLs:**
```
https://admirable-pastelito-032aac.netlify.app/roomscale-4?project=my-project
https://admirable-pastelito-032aac.netlify.app/roomscale-4?key=my-project
https://admirable-pastelito-032aac.netlify.app/roomscale-4?id=my-project
https://admirable-pastelito-032aac.netlify.app/roomscale-4  (uses "default")

https://admirable-pastelito-032aac.netlify.app/refactored?project=my-project
https://admirable-pastelito-032aac.netlify.app/refactored?key=my-project
https://admirable-pastelito-032aac.netlify.app/refactored?id=my-project
https://admirable-pastelito-032aac.netlify.app/refactored  (uses "default")
```

### Loading Sequence

1. **Page Load**: Client extracts project key from URL and determines mode from route (`/roomscale-4` or `/refactored`)
2. **Fetch Assets**: Calls `GET /api/project/{projectKey}`
3. **Mode Detection**: Client checks the `mode` field in the response to confirm which mode to use
4. **Process Assets** (based on mode):
   - **Roomscale Mode**:
     - Process Models: Loads each GLB model into Three.js scene
     - Process CSV: Creates camera markers/cones from CSV data
     - Index Images: Adds 360-degree images (JPEG, PNG) to `imageManager` for on-demand loading
   - **Refactored Mode**:
     - Process Images: Loads SVG floorplates from `images` array
     - Process Unit Floorplans: Loads unit floorplan SVGs from `unitFloorplans` array
5. **Fallback**: If primary endpoint fails, tries legacy endpoints

### File Type Detection

The application supports the following file types:

- **Model Files**: `.glb` files from `model_360-collision_property_variation` folder
- **CSV Files**: `.csv` files from `csv_camera_property_variation` folder
- **Image Files**: `.jpg`, `.jpeg`, `.png` files from `image_360_property_unit` folder
- **SVG Files**: `.svg` files from parent folder structures (e.g., `backplate_image_tower-floorplate`)
  - When an SVG is selected, also loads images from `backplate_image_floorplan_property_unit` into `unitFloorplans` array

**Special Handling:**
- Folders containing "ss" in their name are ignored (case-insensitive)
- When an SVG is selected, all SVGs and images from the parent folder are loaded
- File matching uses type identifiers extracted from filenames

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
        const ext = path.extname(file).toLowerCase();
        let mimeType;
        if (ext === '.svg') {
          mimeType = 'image/svg+xml';
        } else if (ext === '.png') {
          mimeType = 'image/png';
        } else {
          mimeType = 'image/jpeg';
        }
        return {
          imageName: file,
          data: data.toString('base64'),
          mimeType: mimeType
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
            if filename.lower().endswith(('.jpg', '.jpeg', '.png', '.svg')):
                with open(os.path.join(images_dir, filename), 'rb') as f:
                    data = base64.b64encode(f.read()).decode('utf-8')
                    if filename.lower().endswith('.svg'):
                        mime_type = 'image/svg+xml'
                    elif filename.lower().endswith('.png'):
                        mime_type = 'image/png'
                    else:
                        mime_type = 'image/jpeg'
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


