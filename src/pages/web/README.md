# Floorplan Processor - New Project Dialog (Web SPA)

This is a web-based Single Page Application (SPA) version of the New Project Dialog from the Floorplan Processor tool.

## Features

- ✅ Create new projects from CSV or JSON files
- ✅ Project name validation
- ✅ Projects directory selection
- ✅ CSV file upload with format detection (Simple, Original, New, Unreal)
- ✅ CSV preview with up to 100 rows
- ✅ JSON file upload (unit-reference.json and reference.json)
- ✅ JSON preview with file statistics
- ✅ Balcony detection option
- ✅ Rotation offset configuration
- ✅ Real-time validation and status updates
- ✅ Dark mode support
- ✅ Responsive design

## File Structure

```
web/
├── new_project.html    # Main HTML structure
├── styles.css          # Styling with dark mode support
├── app.js              # JavaScript application logic
└── README.md           # This file
```

## Usage

### Standalone Mode

Simply open `new_project.html` in a modern web browser:

```bash
open web/new_project.html
```

Or use a local web server:

```bash
cd web
python -m http.server 8000
# Then visit http://localhost:8000/new_project.html
```

### Integration with Backend

To fully integrate with the Floorplan Processor backend, you'll need to:

1. **Create a REST API** to handle:
   - Directory browsing and validation
   - Project creation
   - File system operations
   - CSV/JSON processing

2. **Example API endpoints:**
   ```
   POST /api/projects/create
   GET  /api/projects/validate-path
   POST /api/projects/browse-directory
   ```

3. **Update app.js** to call these endpoints instead of simulated operations

## CSV Format Support

The application supports 4 CSV formats:

### Format 1 (Simple)
- `Unit_ID`, `Unit_Type`, `MIRROR`, `Rotation` (optional)

### Format 2 (Original)
- `Unit Name`, `Unit Type Dev Final`, `Mirrored`, `Rotation` (optional)

### Format 3 (New)
- `UnitNumber`, `Mirror`, `Code`

### Format 4 (Unreal)
- `UnitID`, `FormattedOutput`, `Rotation_Yaw`

## Browser Compatibility

- Chrome/Edge: ✅ Full support
- Firefox: ✅ Full support
- Safari: ✅ Full support
- Mobile browsers: ✅ Responsive design

## Limitations

### Current Web Implementation

1. **Directory Browsing**: Web browsers have limited file system access. The current implementation uses a text input prompt. For production:
   - Use the File System Access API (Chrome/Edge only)
   - Or implement a backend API for directory browsing

2. **File System Operations**: Project creation requires backend API integration

3. **Path Validation**: Currently simulated; needs backend validation

## Backend Integration Example

Here's a simple Flask API example:

```python
from flask import Flask, request, jsonify
from pathlib import Path

app = Flask(__name__)

@app.route('/api/projects/create', methods=['POST'])
def create_project():
    data = request.json
    project_name = data['projectName']
    projects_dir = Path(data['projectsDir'])
    
    # Create project structure
    project_path = projects_dir / project_name
    project_path.mkdir(parents=True, exist_ok=True)
    
    # ... rest of project creation logic ...
    
    return jsonify({'success': True, 'path': str(project_path)})

@app.route('/api/projects/validate-path', methods=['POST'])
def validate_path():
    path = Path(request.json['path'])
    return jsonify({
        'exists': path.exists(),
        'is_directory': path.is_dir()
    })
```

## Customization

### Styling

Edit `styles.css` to customize:
- Colors (see CSS variables in `:root`)
- Dark mode appearance
- Layout and spacing
- Component styles

### Functionality

Edit `app.js` to:
- Add new CSV formats
- Modify validation rules
- Change preview behavior
- Integrate with backend APIs

## Future Enhancements

- [ ] Drag and drop file upload
- [ ] Better directory picker using File System Access API
- [ ] Real-time CSV validation with detailed errors
- [ ] Project template selection
- [ ] Import/export project settings
- [ ] Multi-language support
- [ ] Progress indicators for large file processing
- [ ] Advanced CSV format auto-detection

## Security Considerations

When implementing backend integration:

1. **Validate all inputs** on the server side
2. **Sanitize file paths** to prevent directory traversal
3. **Limit file sizes** for uploads
4. **Implement authentication** if needed
5. **Use HTTPS** in production
6. **Rate limit API calls**

## License

Same as the parent Floorplan Processor project.

