# Server-Side Implementation Guide for 3D Asset Management

## Overview

This document outlines the server-side implementation for hosting 3D assets (GLB models, camera CSV files, and images) with a single entry point architecture. The server provides a unified API that allows clients to access complete 3D projects via simple URL parameters.

## Architecture Design

### Core Concept
- **Single Entry Point**: All assets for a project are accessible via one endpoint: `/api/project/{projectKey}`
- **URL-Based Access**: Projects can be shared via URLs like `?project=building-a`
- **Unified Response**: One API call returns models, cameras, and images together
- **Backward Compatibility**: Legacy endpoints remain functional

### Technology Stack
- **Framework**: Express.js (Node.js)
- **File Storage**: Local file system (easily adaptable to cloud storage)
- **Data Format**: JSON responses with base64-encoded binary data
- **Upload Handling**: Multipart form data with multer middleware

## File System Structure

```
server/
├── projects/                    # Root directory for all projects
│   ├── building-a/             # Project identifier as folder name
│   │   ├── models/             # GLB/GLTF 3D models
│   │   │   ├── floor1.glb
│   │   │   ├── floor2.glb
│   │   │   └── equipment.glb
│   │   ├── cameras.csv         # Camera positions and rotations
│   │   ├── images/             # Reference images (JPG/PNG/WebP)
│   │   │   ├── view1.jpg
│   │   │   ├── view2.jpg
│   │   │   └── panorama.jpg
│   │   └── metadata.json       # Project metadata and settings
│   ├── warehouse-scan/
│   │   ├── models/
│   │   ├── cameras.csv
│   │   └── images/
│   └── default/                # Fallback project
│       └── ...
├── routes/
│   └── projects.js
├── middleware/
│   ├── cors.js
│   ├── upload.js
│   └── validation.js
├── utils/
│   ├── fileHandlers.js
│   └── projectHelpers.js
└── server.js
```

## API Endpoints

### Primary Endpoint

#### `GET /api/project/{projectKey}`
**Purpose**: Retrieve all assets for a specific project

**Parameters**:
- `projectKey`: String identifier for the project (alphanumeric, hyphens allowed)

**Response Format**:
```json
{
  "projectKey": "building-a",
  "projectPath": "projects/building-a",
  "models": [
    {
      "modelName": "floor1.glb",
      "data": "base64EncodedBinaryData...",
      "size": 1024576,
      "lastModified": "2024-01-15T10:30:00Z"
    }
  ],
  "cameraCSV": {
    "csvName": "cameras.csv",
    "data": "Name,X,Y,Z,RX,RY,RZ\ncamera1,0,0,0,0,0,0\n...",
    "lastModified": "2024-01-15T09:45:00Z"
  },
  "images": [
    {
      "imageName": "view1.jpg",
      "data": "base64EncodedImageData...",
      "mimeType": "image/jpeg",
      "size": 256000,
      "lastModified": "2024-01-15T11:00:00Z"
    }
  ],
  "metadata": {
    "name": "Building A - Floor 1",
    "description": "Complete 3D scan",
    "version": "1.0.0",
    "settings": {...}
  }
}
```

**Error Responses**:
- `404`: Project not found (includes list of available projects)
- `500`: Server error during asset loading

### Supporting Endpoints

#### `GET /api/projects`
**Purpose**: List all available projects

**Response Format**:
```json
{
  "projects": [
    {
      "id": "building-a",
      "name": "Building A - Floor 1",
      "description": "Complete 3D scan",
      "modelCount": 3,
      "imageCount": 15,
      "hasCamera": true,
      "lastModified": "2024-01-15T10:30:00Z"
    }
  ]
}
```

#### `POST /api/project/{projectKey}`
**Purpose**: Create or update a project with new assets

**Content-Type**: `multipart/form-data`

**Form Fields**:
- `models`: Multiple GLB/GLTF files
- `cameras`: Single CSV file
- `images`: Multiple image files
- `metadata`: JSON metadata object or file

**Response**:
```json
{
  "success": true,
  "message": "Project 'building-a' created successfully",
  "url": "/api/project/building-a"
}
```

#### `DELETE /api/project/{projectKey}`
**Purpose**: Remove a project and all its assets

**Response**:
```json
{
  "success": true,
  "message": "Project 'building-a' deleted"
}
```

### Legacy Endpoints (Backward Compatibility)

#### `GET /model`
Returns models from the "default" project

#### `GET /camera-csv`
Returns camera CSV from the "default" project

## Implementation Details

### Project Loading Logic

1. **Validation**: Check if project directory exists
2. **Metadata Loading**: Parse `metadata.json` if available
3. **Model Processing**: 
   - Scan `models/` directory for `.glb` and `.gltf` files
   - Read binary data and encode as base64
   - Collect file statistics
4. **Camera Data**: Load `cameras.csv` as UTF-8 text
5. **Image Processing**:
   - Scan `images/` directory for supported formats
   - Read binary data and encode as base64
   - Detect MIME types from file extensions
6. **Response Assembly**: Combine all assets into unified JSON response

### File Upload Handling

1. **Multipart Processing**: Use multer middleware for file uploads
2. **Directory Creation**: Ensure project structure exists
3. **File Validation**: Check file types and sizes
4. **Storage**: Write files to appropriate subdirectories
5. **Metadata Update**: Create or update project metadata

### Error Handling Strategy

- **Graceful Degradation**: Missing assets don't prevent project loading
- **Detailed Logging**: Log missing directories and files for debugging
- **Client Feedback**: Provide helpful error messages with suggested actions
- **Fallback Options**: Attempt legacy endpoints if primary API fails

## Security Considerations

### Input Validation
- Sanitize project keys (alphanumeric + hyphens only)
- Validate file types and extensions
- Implement file size limits
- Check for directory traversal attempts

### Access Control
- Consider implementing authentication for write operations
- Rate limiting for API endpoints
- CORS configuration for cross-origin requests
- Input sanitization for all user-provided data

### File System Security
- Restrict file uploads to designated directories
- Validate file contents, not just extensions
- Implement virus scanning for uploaded files
- Monitor disk space usage

## Configuration Options

### Environment Variables
```bash
PORT=9234                    # Server port
PROJECTS_DIR=./projects      # Projects root directory
MAX_FILE_SIZE=50MB          # Maximum upload size
CORS_ORIGIN=*               # CORS allowed origins
LOG_LEVEL=info              # Logging verbosity
```

### Server Settings
- Upload size limits per file type
- Concurrent request handling
- Cache headers for static assets
- Compression for large responses

## Deployment Considerations

### Development Setup
1. Create projects directory structure
2. Install dependencies (express, multer, cors)
3. Configure environment variables
4. Start server with nodemon for auto-restart

### Production Deployment
1. **Reverse Proxy**: Use nginx for SSL and static file serving
2. **Process Management**: PM2 for process monitoring and auto-restart
3. **Storage**: Consider cloud storage integration (AWS S3, Google Cloud)
4. **Monitoring**: Implement health checks and logging
5. **Backup**: Regular backup of projects directory

### Scaling Options
- **Horizontal**: Load balancer with multiple server instances
- **Storage**: Separate file storage from application servers
- **Caching**: Redis for frequently accessed project metadata
- **CDN**: Content delivery network for large model files

## Web Tool Integration

### Roomscale-4 Viewer
The server integrates with the roomscale-4 web tool hosted at [https://admirable-pastelito-032aac.netlify.app/roomscale-4/](https://admirable-pastelito-032aac.netlify.app/roomscale-4/). This web application provides advanced 3D visualization and manipulation capabilities for the hosted assets.

### Server-Initiated Web Tool Launch
The server can automatically open or redirect users to the web tool with the appropriate project parameters:

#### Redirect Endpoint
```javascript
// GET /view/{projectKey}
app.get('/view/:projectKey', (req, res) => {
  const { projectKey } = req.params;
  const webToolUrl = `https://admirable-pastelito-032aac.netlify.app/roomscale-4/?project=${projectKey}`;
  res.redirect(webToolUrl);
});
```

#### Integration URLs
- **Direct Access**: `https://admirable-pastelito-032aac.netlify.app/roomscale-4/?project=building-a`
- **Server Redirect**: `https://yourserver.com/view/building-a` → Redirects to web tool
- **API + Tool**: Server provides data, web tool renders the 3D scene

### Project Launch Workflow
1. **Asset Upload**: Upload 3D models, cameras, and images to server via API
2. **Project Creation**: Server creates project structure and validates assets
3. **Web Tool Launch**: Server redirects to or opens the roomscale-4 viewer
4. **Asset Loading**: Web tool fetches project data from server API
5. **3D Visualization**: User interacts with 3D scene in the web application

## Usage Examples

### Client Integration
The client automatically detects project keys from URL parameters:
- `?project=building-a`
- `?key=warehouse-scan`
- `?id=default`

### URL Sharing
Projects can be shared via simple URLs:
```
https://yourapp.com/viewer?project=building-a
https://yourapp.com/viewer?project=warehouse-scan
```

### Web Tool Direct Links
```
https://admirable-pastelito-032aac.netlify.app/roomscale-4/?project=building-a
https://admirable-pastelito-032aac.netlify.app/roomscale-4/?project=warehouse-scan
```

### Programmatic Access
```javascript
// Fetch project data
const response = await fetch('/api/project/building-a');
const projectData = await response.json();

// Load into 3D viewer
loadAssetsFromData(projectData);
```

### Server-Side Web Tool Integration
```javascript
// Launch web tool for a project
function launchWebTool(projectKey) {
  const webToolUrl = `https://admirable-pastelito-032aac.netlify.app/roomscale-4/?project=${projectKey}`;
  
  // Option 1: Redirect response
  return { redirect: webToolUrl };
  
  // Option 2: Return launch URL
  return { launchUrl: webToolUrl };
  
  // Option 3: Programmatic launch (if server has browser automation)
  // exec(`open "${webToolUrl}"`); // macOS
  // exec(`start "${webToolUrl}"`); // Windows
  // exec(`xdg-open "${webToolUrl}"`); // Linux
}
```

## Monitoring and Maintenance

### Health Checks
- Endpoint availability monitoring
- File system space monitoring
- Response time tracking
- Error rate monitoring

### Maintenance Tasks
- Regular cleanup of unused projects
- Log rotation and archival
- Performance optimization based on usage patterns
- Security updates and dependency management

### Analytics
- Track most accessed projects
- Monitor upload/download patterns
- Identify performance bottlenecks
- User engagement metrics

This architecture provides a robust, scalable foundation for hosting and sharing 3D assets while maintaining simplicity for both developers and end users. 