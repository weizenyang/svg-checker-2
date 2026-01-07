// Global state
const state = {
    projectName: '',
    projectsDir: '',
    dataSource: 'csv',
    csvFile: null,
    csvData: [],
    csvFormat: null,
    unitRefFile: null,
    refFile: null,
    jsonData: {},
    detectBalconies: true,
    rotationOffset: 0
};

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    initializeDefaultValues();
});

function initializeDefaultValues() {
    // Set default projects directory (would typically come from backend/storage)
    const defaultDir = '/Users/weizenyang/Documents/GitHub/tools-floorplan_processor/Projects';
    document.getElementById('projectsDir').value = defaultDir;
    state.projectsDir = defaultDir;
    updateProjectsDirStatus();
}

function initializeEventListeners() {
    // Project name input
    document.getElementById('projectName').addEventListener('input', (e) => {
        state.projectName = e.target.value;
        updateProjectPath();
        updateCreateButtonState();
    });

    // Projects directory browse
    document.getElementById('browseDirBtn').addEventListener('click', browseProjectsDirectory);

    // Data source radio buttons
    document.querySelectorAll('input[name="dataSource"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            state.dataSource = e.target.value;
            toggleDataSourceSections();
            updateCreateButtonState();
        });
    });

    // CSV file selection
    document.getElementById('browseCsvBtn').addEventListener('click', () => {
        document.getElementById('csvFileInput').click();
    });
    document.getElementById('csvFileInput').addEventListener('change', handleCsvFileSelect);

    // JSON file selection
    document.getElementById('browseUnitRefBtn').addEventListener('click', () => {
        document.getElementById('unitRefFileInput').click();
    });
    document.getElementById('unitRefFileInput').addEventListener('change', handleUnitRefFileSelect);

    document.getElementById('browseRefBtn').addEventListener('click', () => {
        document.getElementById('refFileInput').click();
    });
    document.getElementById('refFileInput').addEventListener('change', handleRefFileSelect);

    // Checkboxes and inputs
    document.getElementById('detectBalconies').addEventListener('change', (e) => {
        state.detectBalconies = e.target.checked;
    });

    document.getElementById('rotationOffset').addEventListener('input', (e) => {
        state.rotationOffset = parseFloat(e.target.value) || 0;
    });

    // Action buttons
    document.getElementById('cancelBtn').addEventListener('click', handleCancel);
    document.getElementById('createBtn').addEventListener('click', handleCreate);
}

function toggleDataSourceSections() {
    const csvSection = document.getElementById('csvSection');
    const jsonSection = document.getElementById('jsonSection');
    const csvPreviewSection = document.getElementById('csvPreviewSection');
    const jsonPreviewSection = document.getElementById('jsonPreviewSection');

    if (state.dataSource === 'csv') {
        csvSection.style.display = 'block';
        jsonSection.style.display = 'none';
        csvPreviewSection.style.display = 'block';
        jsonPreviewSection.style.display = 'none';
    } else {
        csvSection.style.display = 'none';
        jsonSection.style.display = 'block';
        csvPreviewSection.style.display = 'none';
        jsonPreviewSection.style.display = 'block';
    }
}

function browseProjectsDirectory() {
    // In a real implementation, this would open a native directory picker
    // For web, we'd need a backend API or use the File System Access API
    showToast('Directory selection would require backend API integration', 'warning');
    
    // Simulated directory selection
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Enter directory path';
    input.value = state.projectsDir;
    input.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 1001; padding: 10px; width: 400px;';
    
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000;';
    
    overlay.appendChild(input);
    document.body.appendChild(overlay);
    input.focus();
    
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            state.projectsDir = input.value;
            document.getElementById('projectsDir').value = input.value;
            document.body.removeChild(overlay);
            updateProjectsDirStatus();
            updateProjectPath();
        }
    });
    
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });
}

function updateProjectsDirStatus() {
    const statusEl = document.getElementById('projectsDirStatus');
    // In real implementation, would validate with backend
    if (state.projectsDir) {
        statusEl.textContent = '✅ Projects directory is valid';
        statusEl.className = 'status-message success';
    } else {
        statusEl.textContent = '❌ Projects directory is invalid';
        statusEl.className = 'status-message error';
    }
}

function updateProjectPath() {
    const pathEl = document.getElementById('projectPath');
    const statusEl = document.getElementById('projectStatus');
    
    if (state.projectName && state.projectsDir) {
        const projectPath = `${state.projectsDir}/${state.projectName}`;
        pathEl.textContent = projectPath;
        
        // In real implementation, would check with backend if path exists
        statusEl.textContent = '✅ Project location is available';
        statusEl.className = 'status-message success';
    } else {
        pathEl.textContent = '';
        statusEl.textContent = '';
    }
}

function handleCsvFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    state.csvFile = file;
    document.getElementById('csvFilePath').value = file.name;
    
    loadCsvPreview(file);
}

function handleUnitRefFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    state.unitRefFile = file;
    document.getElementById('unitRefFilePath').value = file.name;
    
    loadJsonPreview();
}

function handleRefFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    state.refFile = file;
    document.getElementById('refFilePath').value = file.name;
    
    loadJsonPreview();
}

async function loadCsvPreview(file) {
    try {
        const text = await file.text();
        const lines = text.split('\n').filter(line => line.trim());
        
        if (lines.length === 0) {
            showCsvStatus('CSV file is empty', 'error');
            return;
        }
        
        // Parse CSV (simple implementation)
        const headers = parseCSVLine(lines[0]);
        const rows = lines.slice(1).map(line => {
            const values = parseCSVLine(line);
            const row = {};
            headers.forEach((header, i) => {
                row[header] = values[i] || '';
            });
            return row;
        });
        
        // Detect format
        const format = detectCsvFormat(headers);
        if (!format) {
            showCsvStatus('CSV format not recognized. Please check the format requirements.', 'error');
            return;
        }
        
        state.csvFormat = format;
        state.csvData = rows;
        
        // Display preview
        displayCsvPreview(rows, format);
        
        showCsvStatus(`Loaded ${rows.length} units successfully - Format: ${format}`, 'success');
        updateCreateButtonState();
        
    } catch (error) {
        console.error('Error loading CSV:', error);
        showCsvStatus(`Error loading CSV: ${error.message}`, 'error');
    }
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current.trim());
    return result;
}

function detectCsvFormat(headers) {
    const simpleFormat = ['Unit_ID', 'Unit_Type', 'MIRROR'];
    const originalFormat = ['Unit Name', 'Unit Type Dev Final', 'Mirrored'];
    const newFormat = ['UnitNumber', 'Mirror', 'Code'];
    const unrealFormat = ['UnitID', 'FormattedOutput', 'Rotation_Yaw'];
    
    if (simpleFormat.every(col => headers.includes(col))) return 'simple';
    if (unrealFormat.every(col => headers.includes(col))) return 'unreal';
    if (newFormat.every(col => headers.includes(col))) return 'new';
    if (originalFormat.every(col => headers.includes(col))) return 'original';
    
    return null;
}

function displayCsvPreview(rows, format) {
    const tbody = document.getElementById('csvPreviewBody');
    tbody.innerHTML = '';
    
    const maxRows = Math.min(rows.length, 100);
    
    for (let i = 0; i < maxRows; i++) {
        const row = rows[i];
        const tr = document.createElement('tr');
        
        let unitName, unitType, mirrored, rotation;
        
        try {
            switch (format) {
                case 'simple':
                    unitName = normaliseName(row['Unit_ID'] || '');
                    unitType = parseUnitTypeBase(row['Unit_Type'] || '');
                    mirrored = ['MIRROR', 'TRUE', 'FLIPPED'].includes((row['MIRROR'] || '').toUpperCase()) ? 'true' : 'false';
                    rotation = row['Rotation'] || '0';
                    break;
                    
                case 'unreal':
                    unitName = normaliseName(row['UnitID'] || '');
                    const [sanitized, isMirrored] = parseFormattedOutput(row['FormattedOutput'] || '');
                    unitType = parseUnitTypeBase(sanitized);
                    mirrored = isMirrored ? 'true' : 'false';
                    rotation = row['Rotation_Yaw'] || '0';
                    break;
                    
                case 'new':
                    unitName = normaliseName(row['UnitNumber'] || '');
                    unitType = parseUnitTypeBase(sanitizeCode(row['Code'] || ''));
                    mirrored = (row['Mirror'] || '').toUpperCase() === 'MIRROR' ? 'true' : 'false';
                    rotation = '0';
                    break;
                    
                default: // original
                    unitName = normaliseName(row['Unit Name'] || '');
                    unitType = parseUnitTypeBase(row['Unit Type Dev Final'] || '');
                    mirrored = ['true', 'mirror', 'flipped'].includes((row['Mirrored'] || '').toLowerCase()) ? 'true' : 'false';
                    rotation = row['Rotation'] || '0';
            }
            
            tr.innerHTML = `
                <td>${unitName}</td>
                <td>${unitType}</td>
                <td>${mirrored}</td>
                <td>${rotation}</td>
            `;
        } catch (error) {
            tr.innerHTML = `<td colspan="4" class="error">Error parsing row: ${error.message}</td>`;
        }
        
        tbody.appendChild(tr);
    }
    
    if (rows.length > 100) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="4" class="no-data">... and ${rows.length - 100} more rows</td>`;
        tbody.appendChild(tr);
    }
}

async function loadJsonPreview() {
    const tbody = document.getElementById('jsonPreviewBody');
    tbody.innerHTML = '';
    
    try {
        let unitCount = 0;
        let typeCount = 0;
        
        // Load unit reference file
        if (state.unitRefFile) {
            const text = await state.unitRefFile.text();
            const data = JSON.parse(text);
            state.jsonData.unit_reference = data;
            unitCount = (data.units || []).length;
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>unit-reference.json</td>
                <td>${unitCount} units</td>
                <td class="success">✅ Loaded</td>
            `;
            tbody.appendChild(tr);
        } else {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>unit-reference.json</td>
                <td>0 units</td>
                <td class="error">❌ Not selected</td>
            `;
            tbody.appendChild(tr);
        }
        
        // Load reference file
        if (state.refFile) {
            const text = await state.refFile.text();
            const data = JSON.parse(text);
            state.jsonData.reference = data;
            typeCount = (data.types || []).length;
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>reference.json</td>
                <td>${typeCount} types</td>
                <td class="success">✅ Loaded</td>
            `;
            tbody.appendChild(tr);
        } else {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>reference.json</td>
                <td>0 types</td>
                <td class="error">❌ Not selected</td>
            `;
            tbody.appendChild(tr);
        }
        
        if (state.unitRefFile && state.refFile) {
            showJsonStatus(`Loaded ${unitCount} units and ${typeCount} types successfully`, 'success');
        } else {
            showJsonStatus('Please select both unit-reference.json and reference.json files', 'warning');
        }
        
        updateCreateButtonState();
        
    } catch (error) {
        console.error('Error loading JSON:', error);
        showJsonStatus(`Error loading JSON: ${error.message}`, 'error');
    }
}

// Utility functions (simplified versions of Python logic)

function normaliseName(raw) {
    // Three-part pattern: building-floor-unit
    let m = raw.match(/\b([A-Za-z0-9]+)[-_]([A-Za-z0-9]+)[-_](\d{2})\b/);
    if (m) {
        const [, building, floorRaw, unit] = m;
        const floor = /^\d+$/.test(floorRaw) ? floorRaw.padStart(2, '0') : floorRaw.toLowerCase();
        return `${building.toLowerCase()}-${floor}-${unit}`;
    }
    
    // Two-part with combined floor+unit
    m = raw.match(/\b([A-Za-z0-9]+)[-_](\d{3,4})\b/);
    if (m) {
        const [, building, floorunit] = m;
        let floor, unit;
        if (floorunit.length === 3) {
            floor = floorunit[0];
            unit = floorunit.slice(1);
        } else {
            floor = floorunit.slice(0, 2);
            unit = floorunit.slice(2);
        }
        floor = floor.padStart(2, '0');
        return `${building.toLowerCase()}-${floor}-${unit}`;
    }
    
    // Two-part with letter+digit
    m = raw.match(/\b([A-Za-z0-9]+)[-_]([A-Za-z])(\d{2,3})\b/);
    if (m) {
        const [, building, floorLetter, unitDigits] = m;
        return `${building.toLowerCase()}-${floorLetter.toLowerCase()}-${unitDigits}`;
    }
    
    // Two-part: building-unit
    m = raw.match(/\b([A-Za-z0-9]+)[-_](\d{2,3})\b/);
    if (m && m[2].length < 3) {
        const [, building, unit] = m;
        return `${building.toLowerCase()}-${unit}`;
    }
    
    return raw.toLowerCase();
}

function parseUnitTypeBase(unitTypeRaw) {
    const unitType = unitTypeRaw.toLowerCase().trim();
    
    if (unitType.endsWith('_s1_0') || unitType.endsWith('_s2_0')) {
        return unitType.slice(0, -5);
    } else if (unitType.endsWith('_s1') || unitType.endsWith('_s2')) {
        return unitType.slice(0, -3);
    }
    return unitType;
}

function sanitizeCode(code) {
    if (!code) return code;
    
    const parts = code.split('_');
    if (parts.length >= 3) {
        const thirdSegment = parts[2];
        if (thirdSegment.endsWith('BF')) {
            parts[2] = thirdSegment.slice(0, -2) + 'B';
        } else if (thirdSegment === 'SF') {
            parts[2] = 'S';
        }
        return parts.join('_');
    }
    return code;
}

function parseFormattedOutput(formattedOutput) {
    if (!formattedOutput) return [formattedOutput, false];
    
    const parts = formattedOutput.split('_');
    let isMirrored = false;
    
    if (parts.length >= 3) {
        const thirdSegment = parts[2];
        if (thirdSegment.includes('BF')) {
            isMirrored = true;
            parts[2] = thirdSegment.replace('BF', 'B');
        }
    }
    
    return [parts.join('_'), isMirrored];
}

function showCsvStatus(message, type = 'info') {
    const statusEl = document.getElementById('csvStatus');
    statusEl.textContent = message;
    statusEl.className = `status-message ${type}`;
}

function showJsonStatus(message, type = 'info') {
    const statusEl = document.getElementById('jsonStatus');
    statusEl.textContent = message;
    statusEl.className = `status-message ${type}`;
}

function updateCreateButtonState() {
    const createBtn = document.getElementById('createBtn');
    
    const validName = state.projectName.trim().length > 0 && isValidProjectName(state.projectName);
    const validDir = state.projectsDir.trim().length > 0;
    
    let validData = false;
    if (state.dataSource === 'csv') {
        validData = state.csvFile && state.csvData.length > 0;
    } else {
        validData = state.unitRefFile && state.refFile && 
                   Object.keys(state.jsonData).length > 0;
    }
    
    createBtn.disabled = !(validName && validDir && validData);
}

function isValidProjectName(name) {
    const invalidChars = '<>:"/\\|?*';
    if ([...name].some(char => invalidChars.includes(char))) {
        return false;
    }
    return name.trim().length > 0 && name.length <= 50;
}

function handleCancel() {
    if (confirm('Are you sure you want to cancel? All entered data will be lost.')) {
        window.close();
        // If window.close() doesn't work (popup blockers), redirect
        setTimeout(() => {
            window.location.href = 'about:blank';
        }, 100);
    }
}

async function handleCreate() {
    const createBtn = document.getElementById('createBtn');
    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';
    
    try {
        // In a real implementation, this would send data to backend API
        // For now, we'll simulate the project creation
        
        const projectData = {
            projectName: state.projectName,
            projectsDir: state.projectsDir,
            dataSource: state.dataSource,
            detectBalconies: state.detectBalconies,
            rotationOffset: state.rotationOffset
        };
        
        if (state.dataSource === 'csv') {
            projectData.csvData = state.csvData;
            projectData.csvFormat = state.csvFormat;
        } else {
            projectData.jsonData = state.jsonData;
        }
        
        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        console.log('Creating project with data:', projectData);
        
        showToast(`Project '${state.projectName}' created successfully!`, 'success');
        
        // Reset form or close window
        setTimeout(() => {
            if (confirm('Project created! Would you like to create another project?')) {
                location.reload();
            } else {
                window.close();
            }
        }, 2000);
        
    } catch (error) {
        console.error('Error creating project:', error);
        showToast(`Failed to create project: ${error.message}`, 'error');
        createBtn.disabled = false;
        createBtn.textContent = 'Create Project';
    }
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 5000);
}

