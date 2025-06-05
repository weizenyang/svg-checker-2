# Roomscale 3D Visualizer

A powerful web-based 3D visualization tool for working with spatial camera data, building models, and immersive 360-degree imagery. Perfect for architects, surveyors, facility managers, and anyone working with spatial positioning and building visualization.

![Version](https://img.shields.io/badge/version-0.0.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## 🎯 Overview

Roomscale 3D Visualizer transforms complex spatial data into intuitive 3D visualizations. Import camera position data, 3D building models, and VR imagery into one comprehensive 3D environment where you can explore, analyze, and generate immersive 360-degree experiences.

### ✨ Key Features

- **📍 3D Camera Positioning**: Visualize camera positions as interactive cones in 3D space
- **🏢 3D Model Support**: Import and display GLB, GLTF, and FBX building models  
- **🌐 360° Panoramic Generation**: Create immersive equirectangular panoramic images
- **🏗️ Multi-Floor Building Management**: Organize and navigate complex multi-story structures
- **🎮 Interactive 3D Navigation**: Smooth camera controls with orbit, pan, and zoom
- **📁 Batch File Processing**: Handle multiple models and data files simultaneously
- **🔄 Real-time VR Preview**: Toggle between actual photos and generated 360° views
- **📤 Export Capabilities**: Export 3D scenes as GLB files or 360° image batches
- **🎛️ Advanced Controls**: Coordinate transformations, scaling, and material adjustments

## 🚀 Getting Started

### Prerequisites

- Node.js (version 18 or higher)
- npm or yarn package manager
- Modern web browser with WebGL support

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/[your-username]/svg-checker-2.git
   cd svg-checker-2
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the development server**
   ```bash
   npm run dev
   ```

4. **Open your browser**
   Navigate to `http://localhost:4321/roomscale-4`

## 📖 How to Use

### Step 1: Import Your Data

**Import Camera Position Data**
- **Required**: CSV file with camera coordinates and orientations
- **Format**: `name,x,y,z,rx,ry,rz` (position and rotation data)
- **Floor Support**: Include floor identifiers in camera names (e.g., "L01_CAM_001")
- Drag and drop your CSV file into the viewport
- Camera positions appear as red cones in 3D space

**Load 3D Building Models**
- **Required**: GLB, GLTF, or FBX model files
- **Multiple Models**: Support for complex scenes with multiple buildings
- Drag and drop 3D model files
- Models automatically scale and position in the scene
- Use wireframe mode to see internal structures

**Add VR Reference Images**
- **Optional**: JPG/PNG images matching camera position names
- **Naming Convention**: Images should match camera names for automatic linking
- Drag and drop image files
- Click camera cones to view associated VR images

### Step 2: Navigate and Explore

**3D Scene Navigation**
- Use mouse/trackpad to orbit around the scene
- Double-click objects to focus the camera on them
- Use keyboard controls (WASD/Arrow keys) for precise movement
- Toggle between orthographic and perspective views

**Multi-Floor Management**
- **Floor Controls**: Use checkboxes in the Floors panel to toggle floor visibility
- **Floor Organization**: Tool automatically detects floors from camera names
- **Independent Editing**: Each floor maintains separate visibility state
- **Multi-Level Analysis**: Combine floors for comprehensive building analysis

### Step 3: Adjust and Configure

**Coordinate Transformations**
- **Required Fields**: Use flip buttons for X/Y/Z axis transformations
- **Scaling**: Adjust overall scene scale with the scale slider
- **Centering**: Auto-center camera positions with CSV centering
- **Alignment**: Use alignment tools to match models with camera data

**Visual Settings**
- **Cone Size**: Adjust camera position marker size
- **Labels**: Toggle camera position labels on/off
- **Face Orientation**: Visualize 3D model surface normals
- **Wireframe**: Switch between solid and wireframe rendering

### Step 4: Generate 360° Content

**Single View Generation**
- Click any camera cone to view immediate 360° preview
- Toggle between actual photos and generated panoramas
- Use VR panel to preview and resize viewport
- Click same cone twice to switch between photo/generated views

**Batch Export Setup**
- **Scene Preparation**: Ensure 3D models and camera positions are loaded
- **Quality Settings**: Tool generates 4096x2048 equirectangular images
- **Lighting**: Automatic point lights added at each camera position
- **Materials**: White override material for consistent rendering

**Export Collections**
- **Individual Groups**: Right-click CSV groups to export specific floor/area 360° views
- **Complete Export**: Use "Export All Groups 360°" for comprehensive batch export
- **Output Format**: ZIP files with organized panoramic images
- **Naming**: Automatic naming with original and horizontally-flipped versions

### Step 5: Export and Share

**3D Scene Export**
- Export entire scene or individual components as GLB files
- Maintain floor organization in exported files
- Choose between full scene or selective object export

**360° Image Export**
- **Ready-to-Use**: Creates equirectangular images compatible with VR headsets
- **Multiple Versions**: Includes normal and flipped versions for different platforms
- **Organization**: Automatically organized by building groups and floors
- **Quality Assurance**: Check generated panoramas in VR viewers

## 🎮 Controls & Navigation

### Mouse Controls
| Action | Control |
|--------|---------|
| Orbit Camera | Left click + drag |
| Pan View | Right click + drag |
| Zoom | Mouse wheel |
| Focus Object | Double-click |
| VR Preview | Single click on camera cone |

### Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `W` / `↑` | Move forward |
| `S` / `↓` | Move backward |
| `A` / `←` | Rotate left |
| `D` / `→` | Rotate right |

### UI Controls
- **Coordinate Flips**: X/Y/Z axis transformations
- **Scale Slider**: Adjust overall scene scale
- **Cone Size**: Change camera position marker size
- **Center CSV**: Auto-center camera positions
- **Show Labels**: Toggle camera position labels
- **Face Orientation**: Visualize 3D model surface normals

## 💡 Tips & Best Practices

### Data Preparation:
- Name camera CSV files consistently with floor identifiers (L01, L02, etc.)
- Keep 3D models properly scaled (tool auto-scales GLB to 100x)
- Match VR image names to camera position names for automatic linking
- Ensure camera positions are at realistic heights for believable 360° views

### Scene Management:
- Use wireframe mode to understand model geometry
- Test floor visibility controls before final export
- Use coordinate transformation tools to align different data sources
- Apply proper materials and lighting for quality 360° generation

### Export Optimization:
- Export floors separately for better file management
- Use batch export for large building surveys
- Check generated panoramas in VR viewers for quality assurance
- Organize exported files by building groups and floors

## 📁 Supported File Formats

### Input Formats
- **3D Models**: .glb, .gltf, .fbx
- **Camera Data**: .csv (comma-separated values)
- **VR Images**: .jpg, .png
- **Compressed Models**: DRACO compression supported

### Output Formats
- **3D Scenes**: .glb (binary GLTF)
- **360° Images**: .jpg (equirectangular format)
- **Batch Exports**: .zip (organized collections)

## 🛠️ Development

### Project Structure
```
src/
├── pages/
│   └── roomscale-4.astro     # Main 3D visualization interface
├── scripts/
│   └── three/                # Three.js library and extensions
└── public/
    └── draco/                # DRACO compression decoder
```

### Built With
- **Three.js** - 3D graphics engine
- **Astro** - Web framework
- **WebGL** - Hardware-accelerated rendering
- **DRACO** - 3D model compression

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/3d-enhancement`)
3. Commit your changes (`git commit -m 'Add 360° stereo rendering'`)
4. Push to the branch (`git push origin feature/3d-enhancement`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙋‍♂️ Support

If you encounter any issues or have questions:

1. Check the [Issues](https://github.com/[your-username]/svg-checker-2/issues) page
2. Include your browser version and GPU information
3. Provide sample files if experiencing import issues
4. Describe the 3D scene setup when reporting rendering problems

---

**Built for spatial professionals who need powerful 3D visualization tools** 🌐 