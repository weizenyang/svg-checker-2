import DxfParser from "dxf-parser";

// Helper function to strip MTEXT formatting codes
export function stripMtextFormatting(text: string | undefined): string {
	if (!text) return text || '';
	// Remove line break codes like \A1;
	return text.replace(/\\A\d+;/g, '');
}

// Helper function to extract dimension data from DXF
export function extractDimensionData(dxf: any) {
	const dimensionData: Record<string, number> = {};
	
	if (!dxf || !dxf.entities) return dimensionData;
	
	// Find all DIMENSION entities
	const dimensions = dxf.entities.filter((e: any) => e.type === 'DIMENSION');
	
	dimensions.forEach((dim: any) => {
		// Get measurement
		const measurement = dim.measurement || dim.actualMeasurement || 0;
		
		// Get text from dimension block if available
		let text = dim.text || '';
		
		// Try to get text from associated block
		if (dxf.blocks && dim.block) {
			const block = dxf.blocks[dim.block];
			if (block && block.entities) {
				for (const entity of block.entities) {
					if (entity.type === 'MTEXT' || entity.type === 'TEXT') {
						text = stripMtextFormatting(entity.text || '');
						break;
					}
				}
			}
		}
		
		if (text) {
			dimensionData[text] = measurement;
		}
	});
	
	return dimensionData;
}

// Convert DXF entities to SVG paths
export function dxfEntitiesToSVG(dxf: any, layerNames: string[] | null = null) {
	if (!dxf || !dxf.entities) return '';
	
	let svgPaths = '';
	
	// Filter entities by layer if specified
	const filteredEntities = layerNames 
		? dxf.entities.filter((e: any) => layerNames.includes(e.layer))
		: dxf.entities;
	
	filteredEntities.forEach((entity: any) => {
		let path = '';
		
		switch (entity.type) {
			case 'LINE':
				if (entity.start && entity.end) {
					path = `M ${entity.start.x} ${entity.start.y} L ${entity.end.x} ${entity.end.y}`;
				}
				break;
			case 'LWPOLYLINE':
			case 'POLYLINE':
				if (entity.vertices && entity.vertices.length > 0) {
					path = `M ${entity.vertices[0].x} ${entity.vertices[0].y}`;
					for (let i = 1; i < entity.vertices.length; i++) {
						path += ` L ${entity.vertices[i].x} ${entity.vertices[i].y}`;
					}
					if (entity.closed) {
						path += ' Z';
					}
				}
				break;
			case 'ARC':
				if (entity.center && entity.radius !== undefined) {
					const startAngle = (entity.startAngle || 0) * Math.PI / 180;
					const endAngle = (entity.endAngle || 360) * Math.PI / 180;
					const startX = entity.center.x + entity.radius * Math.cos(startAngle);
					const startY = entity.center.y + entity.radius * Math.sin(startAngle);
					const endX = entity.center.x + entity.radius * Math.cos(endAngle);
					const endY = entity.center.y + entity.radius * Math.sin(endAngle);
					const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
					path = `M ${startX} ${startY} A ${entity.radius} ${entity.radius} 0 ${largeArc} 1 ${endX} ${endY}`;
				}
				break;
			case 'CIRCLE':
				if (entity.center && entity.radius !== undefined) {
					// Convert circle to path
					const cx = entity.center.x;
					const cy = entity.center.y;
					const r = entity.radius;
					path = `M ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}`;
				}
				break;
			case 'SPLINE':
				if (entity.controlPoints && entity.controlPoints.length > 0) {
					path = `M ${entity.controlPoints[0].x} ${entity.controlPoints[0].y}`;
					for (let i = 1; i < entity.controlPoints.length; i++) {
						path += ` L ${entity.controlPoints[i].x} ${entity.controlPoints[i].y}`;
					}
				}
				break;
		}
		
		if (path) {
			// Create a group for each entity with its layer name
			const groupId = `patch-${entity.handle || Math.random().toString(36).substr(2, 9)}`;
			svgPaths += `<g id="${groupId}" stroke="white" stroke-width="1" fill="none">
				<path d="${path}"/>
			</g>`;
		}
	});
	
	return svgPaths;
}

// Process a single DXF file
export async function processDXFFile(file: File) {
	return new Promise<{ file: string; success: boolean; error?: string }>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = (e) => {
			try {
				const parser = new DxfParser();
				const dxf = parser.parseSync(e.target.result as string);
				
				// Extract dimension data
				const dimensionData = extractDimensionData(dxf);
				
				// Convert to SVG (only KT-Dim layer)
				const svgPaths = dxfEntitiesToSVG(dxf, ['KT-Dim']);
				
				// Calculate bounding box
				let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
				if (dxf.entities) {
					dxf.entities.filter((e: any) => e.layer === 'KT-Dim').forEach((entity: any) => {
						if (entity.start) {
							minX = Math.min(minX, entity.start.x);
							maxX = Math.max(maxX, entity.start.x);
							minY = Math.min(minY, entity.start.y);
							maxY = Math.max(maxY, entity.start.y);
						}
						if (entity.end) {
							minX = Math.min(minX, entity.end.x);
							maxX = Math.max(maxX, entity.end.x);
							minY = Math.min(minY, entity.end.y);
							maxY = Math.max(maxY, entity.end.y);
						}
						if (entity.vertices) {
							entity.vertices.forEach((v: any) => {
								minX = Math.min(minX, v.x);
								maxX = Math.max(maxX, v.x);
								minY = Math.min(minY, v.y);
								maxY = Math.max(maxY, v.y);
							});
						}
					});
				}
				
				// Default viewBox if no entities found
				if (!isFinite(minX)) {
					minX = 0; maxX = 4096; minY = 0; maxY = 4096;
				}
				
				const width = maxX - minX || 4096;
				const height = maxY - minY || 4096;
				
				// Create SVG with comments
				let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}">
`;
				
				// Add dimension comments to groups
				const groups = svgPaths.match(/<g[^>]*>[\s\S]*?<\/g>/g) || [];
				groups.forEach(group => {
					const groupIdMatch = group.match(/id="([^"]+)"/);
					if (groupIdMatch) {
						const groupId = groupIdMatch[1];
						// Find matching dimension text
						for (const [text, measurement] of Object.entries(dimensionData)) {
							if (groupId.includes('patch')) {
								svgContent += `  <!-- Dimension: ${text} | Measurement: ${measurement} | Group Id: ${groupId} -->\n`;
								break;
							}
						}
					}
					svgContent += `  ${group}\n`;
				});
				
				svgContent += '</svg>';
				
				// Create download
				const blob = new Blob([svgContent], { type: 'image/svg+xml' });
				const url = URL.createObjectURL(blob);
				const link = document.createElement('a');
				link.href = url;
				link.download = file.name.replace(/\.dxf$/i, '.svg');
				link.click();
				URL.revokeObjectURL(url);
				
				resolve({ file: file.name, success: true });
			} catch (error: any) {
				console.error(`Error processing ${file.name}:`, error);
				reject({ file: file.name, error: error.message });
			}
		};
		reader.onerror = () => reject({ file: file.name, error: 'Failed to read file' });
		reader.readAsText(file);
	});
}


