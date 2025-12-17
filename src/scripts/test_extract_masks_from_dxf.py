import ezdxf
from ezdxf.addons.drawing import RenderContext, Frontend
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
import xml.etree.ElementTree as ET
from xml.dom import minidom
import matplotlib.pyplot as plt
import re
import os

def list_dxf_layers(dxf_file):
    doc = ezdxf.readfile(dxf_file)
    msp = doc.modelspace()

    layers = {}
    for entity in msp:
        layer = entity.dxf.layer
        if layer not in layers:
            layers[layer] = 0
        layers[layer] += 1
    
    print("Layers found:")
    for layer, count in sorted(layers.items()):
        print(f"  {layer}: {count} entities")
    
    return layers


def investigate_dimensions(dxf_file, layer_name="KT-Dim"):
    """
    Investigate the dimensions, and other attributes,
    of the text boxes in the original dxf file
    """
    doc = ezdxf.readfile(dxf_file)
    msp = doc.modelspace()

    dims = [e for e in msp if e.dxftype() == 'DIMENSION' and e.dxf.layer == layer_name]
    # print(dims)

    for i, dim in enumerate(dims[:10]):
        print(f"Dimension #{i+1}")
        #print(f"Available attributes: {[attr for attr in dir(dim.dxf) if not attr.startswith('_')]}")

        measurement = dim.dxf.get('actual_measurement', 'N/A')
        print(f"Actual measurement: {measurement}")

        text = dim.dxf.get('text', None)
        print(f"Text override: {repr(text)}")

        geometry = dim.dxf.get('geometry', None)
        print(f"Geometry block: {geometry}")

        if geometry and geometry in doc.blocks:
            block = doc.blocks[geometry]
            print(f"Block has {len(block)} entities:")
            for entity in block:
                print(f"  - {entity.dxftype()}")
                if entity.dxftype() == 'MTEXT':
                    content = entity.dxf.get('text', 'N/A')
                    print(f"    Content: {repr(content)}")
                    char_height = entity.dxf.get('char_height', 'N/A')
                    print(f"    Char height: {char_height}")
                    width = entity.dxf.get('width', 'N/A')
                    print(f"    Width: {width}")
                elif entity.dxftype() == 'TEXT':
                    content = entity.dxf.get('text', 'N/A')
                    print(f"    Content: {repr(content)}")
                    height = entity.dxf.get('height', 'N/A')
                    print(f"    Height: {height}")
        print()


def dxf_layer_to_svg(doc, output_svg, layer_names=None):
    """Render document to SVG"""
    
    msp = doc.modelspace()
    
    if layer_names:
        layer_table = doc.layers
        for layer in layer_table:
            if layer.dxf.name not in layer_names:
                layer.off()
            else:
                layer.on()
                
    plt.rcParams['text.color'] = 'white'
    plt.rcParams['axes.edgecolor'] = 'white'
    plt.rcParams['xtick.color'] = 'white'
    plt.rcParams['ytick.color'] = 'white'

    fig = plt.figure(figsize=(20, 20))
    fig.patch.set_alpha(0.0)

    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_facecolor('none')

    ctx = RenderContext(doc)

    ctx.current_line_pattern = None

    out = MatplotlibBackend(ax)
    Frontend(ctx, out).draw_layout(msp, finalize=True)

    # for line in ax.get_lines():
    #     line.set_color('white')

    # for text in ax.texts:
    #     text.set_color('white')
    for artist in ax.get_children():
        if hasattr(artist, 'set_color'):
            artist.set_color('white')
        if hasattr(artist, 'set_edgecolor'):
            artist.set_edgecolor('white')
        if hasattr(artist, 'set_facecolor'):
            artist.set_facecolor('white')

    fig.savefig(output_svg, format='svg', bbox_inches='tight', dpi=300, transparent=True)
    plt.close(fig)
    print(f"SVG saved to {output_svg}")


def format_dimension_text(dxf_file):
    doc = ezdxf.readfile(dxf_file)
    
    dims = [e for e in doc.modelspace() if e.dxftype() == 'DIMENSION']
    
    for dim in dims:
        geometry = dim.dxf.get('geometry', None)
        
        if geometry and geometry in doc.blocks:
            block = doc.blocks[geometry]
            
            for entity in block:
                if entity.dxftype() == 'MTEXT':
                    entity.dxf.text = strip_mtext_formatting(entity.dxf.text)
    
    return doc


def strip_mtext_formatting(text):
    """Remove MTEXT formatting codes"""

    if not text:
        return text
    
    cleaned = re.sub(r'\\A\d+;', '', text) # line break
    return cleaned


def add_svg_comments(svg_file, doc):
    """Add comments inside SVG groups containing dimension text and prettify"""

    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')
    
    # get all dimension texts with their measurements
    dimension_data = {}
    dims = [e for e in doc.modelspace() if e.dxftype() == 'DIMENSION']
    
    for dim in dims:
        geometry = dim.dxf.get('geometry', None)
        if geometry and geometry in doc.blocks:
            block = doc.blocks[geometry]
            for entity in block:
                if entity.dxftype() == 'MTEXT':
                    text = strip_mtext_formatting(entity.dxf.text)
                    measurement = dim.dxf.get('actual_measurement', 0)
                    dimension_data[text] = measurement
                    break
    
    # parse SVG
    tree = ET.parse(svg_file)
    root = tree.getroot()
    
    # find all groups with id containing "patch"
    comments_added = 0
    for group in root.iter('{http://www.w3.org/2000/svg}g'):
        group_id = group.get('id', '')
        if 'patch' in group_id:
            for text_value, measurement in dimension_data.items():
                comment = ET.Comment(f' Dimension: {text_value} | Group Id: {group_id} ')
                group.insert(0, comment)
                comments_added += 1
                break

    try:
        ET.indent(tree, space="  ")
    except AttributeError:
        pass
    
    tree.write(svg_file, encoding='unicode', xml_declaration=True)
    print(f"Added {comments_added} comments to groups")


if __name__ == "__main__":

    dxf_folder = "/Users/weizenyang/Downloads/the wilds DXF- dims"
    dxf_files = [f for f in os.listdir(dxf_folder) if f.endswith('.dxf')]

    for dxf_filename in dxf_files:
        dxf_file = os.path.join(dxf_folder, dxf_filename)
        print(f"Processing: {dxf_file}")
        
        doc = format_dimension_text(dxf_file)
        output_file = os.path.join(dxf_folder, f"{dxf_filename.split('.')[0]}.svg")

        # list_dxf_layers(dxf_file)
        # investigate_dimensions(dxf_file, layer_name="KT-Dim")

        dxf_layer_to_svg(doc, output_file, ["KT-Dim"])
        add_svg_comments(output_file, doc)