# SVG Checker 2

A modern web-based tool for editing and managing SVG floor plans with coordinate data. Perfect for architects, facility managers, and anyone working with building layouts and point coordinates.

![Version](https://img.shields.io/badge/version-0.0.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## 🏢 Overview

SVG Checker 2 simplifies the process of working with architectural floor plans and coordinate data. The tool operates in three distinct modes to handle different workflows: managing CSV coordinate data, editing multi-story tower floorplates, and quality assurance verification between floorplates and floorplans.

### ✨ Key Features

- **📁 Multi-Format Import**: Drag-and-drop support for SVG, CSV, and image files
- **🎯 Visual Point Editing**: Click and drag points directly on floor plans
- **🏗️ Multi-Floor Management**: Organize and view multi-story buildings with ease
- **🔄 Coordinate Transformation**: Flip, rotate, and scale coordinates as needed
- **🏷️ Smart Labeling**: Toggle point labels and customize ID formatting
- **📐 Pan & Zoom**: Navigate large floor plans with smooth controls
- **👥 Batch Operations**: Select multiple points for efficient group editing
- **📤 Flexible Export**: Export to SVG or CSV in multiple resolutions
- **🔍 QA Verification**: Compare floorplate images against floorplan drawings

## 🚀 Getting Started

### Prerequisites

- Node.js (version 18 or higher)
- npm or yarn package manager

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
   Navigate to `http://localhost:4321`

## 📖 How to Use

SVG Checker 2 operates in three main modes depending on your workflow:

## 📊 Mode 1: Floorplan CSV Mode

**Purpose**: Import and edit CSV coordinate data on floor plan backgrounds

### Workflow:

1. **Import CSV Data**
   - **Required**: CSV file with coordinate data (camera or floorplan format)
   - Drag and drop your CSV file with point coordinates
   - Supports both 3-column (name, x, y) and 4-column (name, x, y, z) formats
   - Tool automatically detects and transforms camera CSV data

2. **Configure Point Display**
   - **Required**: Select ID formatting option
   - Choose from underscore, dash, none, or full underscore formatting
   - Points automatically appear on the canvas with labels

3. **Edit and Refine**
   - Click points to select and edit properties
   - Set group names and unit numbers
   - Add new points or delete unwanted ones
   - Use coordinate transformations (flip X/Y, rotate) as needed

4. **Export Results**
   - **Required**: Set filename and choose export format
   - Export as SVG for visual use or CSV for coordinate data
   - Choose resolution (4096px or 2048px for CSV)

## 🏗️ Mode 2: Tower Floorplate Mode

**Purpose**: Manage and edit multi-story building floorplates with floor-by-floor organization

### Workflow:

1. **Import Multi-Floor Data**
   - **Required**: CSV file with floor identifiers in point names
   - Import coordinate data that includes floor information
   - Tool automatically detects and organizes points by floor

2. **Manage Floor Visibility**
   - **Required**: Use floor checkboxes to control visibility
   - Toggle individual floors on/off for focused editing
   - Use "Aggregate points" to combine data from multiple camera positions
   - Each floor can be edited independently

3. **Edit Floor-Specific Points**
   - Select points on specific floors
   - Apply transformations per floor or globally
   - Manage point properties within floor context
   - Add or remove points from specific floors

4. **Export Tower Data**
   - Export complete tower data or individual floors
   - Maintain floor organization in exported files
   - Choose appropriate coordinate systems for each floor

## 🔍 Mode 3: Floorplate x Floorplan QA Mode

**Purpose**: Quality assurance verification by comparing actual floorplate images against floorplan drawings

### Workflow:

1. **Import Base Floorplan**
   - **Required**: SVG floorplan file as base reference
   - Import your architectural floorplan drawing
   - This serves as the "truth" reference

2. **Add Floorplate Images**
   - **Required**: Actual floorplate photographs or scans
   - Click "Check Floorplans" to import multiple images
   - Tool displays images in a carousel for easy navigation
   - Images overlay on the floorplan for comparison

3. **Configure Text Replacement**
   - **Required**: Set text to remove from point IDs for matching
   - Use "To Remove" field to clean up point names
   - Helps match image filenames to floorplan elements

4. **Perform QA Verification**
   - Hover over floorplan elements to see corresponding images
   - Verify that actual floorplates match the planned layout
   - Identify discrepancies between plan and reality
   - Use image previews to spot issues or confirm accuracy

5. **Document Findings**
   - Export annotated floorplans with QA notes
   - Clear images when moving to next verification set
   - Maintain records of verification process

## 🎮 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Escape` | Deselect all points |
| `Shift + Click` | Multi-select points |
| `Ctrl + A` | Select all points |
| `Enter` | Apply group/unit settings |
| `Q` | Apply unit numbering |
| `Delete` / `Backspace` | Delete selected points |
| `L` | Toggle labels |
| `←` / `→` | Rotate points 45° |

## 💡 Tips & Best Practices

### For Floorplan CSV Mode:
- Keep CSV files properly formatted with consistent naming
- Use coordinate transformations to align with your reference system
- Export at appropriate resolution for your intended use

### For Tower Floorplate Mode:
- Ensure floor identifiers are consistent in your CSV data
- Use aggregate mode when you have multiple camera positions per floor
- Work floor-by-floor for complex towers to maintain organization

### For QA Mode:
- Name your floorplate images to match floorplan element IDs
- Use the text replacement feature to standardize naming conventions
- Clear images between different QA sessions to avoid confusion
- Document any discrepancies found during verification

## 🛠️ Development

### Project Structure

```
src/
├── components/          # Reusable UI components
├── pages/              # Main application pages
│   └── refactored.astro # Primary SVG editor interface
├── scripts/            # Utility libraries
└── styles.css          # Global styles
```

### Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |

### Built With

- **Astro** - Web framework
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **Three.js** - 3D graphics support

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙋‍♂️ Support

If you encounter any issues or have questions:

1. Check the [Issues](https://github.com/[your-username]/svg-checker-2/issues) page
2. Create a new issue with detailed information
3. Include your browser version and any error messages

---

**Made with ❤️ for the architectural and facility management community**
