import ezdxf
from ezdxf.addons.drawing import RenderContext, Frontend
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
import xml.etree.ElementTree as ET
from xml.dom import minidom
import matplotlib.pyplot as plt
import re
import os
import shutil

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


def _parse_svg_size(svg_path):
    """Parse SVG viewBox or width/height. Returns (minx, miny, w, h) or None on failure."""
    try:
        tree = ET.parse(svg_path)
        root = tree.getroot()
    except Exception:
        return None

    view_box = root.get("viewBox")
    if view_box:
        parts = view_box.strip().replace(",", " ").split()
        if len(parts) != 4:
            return None
        try:
            return float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])
        except ValueError:
            return None

    # fallback to width/height (strip units: px, pt, etc.)
    def parse_len(s, default=1):
        if s is None:
            return default
        s = re.sub(r"[a-zA-Z%]+", "", str(s).strip())
        try:
            return float(s) if s else default
        except ValueError:
            return default

    w = parse_len(root.get("width"), 1)
    h = parse_len(root.get("height"), 1)
    return 0, 0, w, h


def split_svg_halves_if_needed(svg_path, base_name):
    """
    If base_name starts with 'd_s' and SVG aspect ratio > 1.8 (landscape),
    split the SVG into left and right halves and export as base_0.svg and base_1.svg.
    Returns True if split was done, False otherwise.
    """
    if not base_name.startswith("d_s"):
        return False
    if not os.path.isfile(svg_path):
        return False

    try:
        parsed = _parse_svg_size(svg_path)
        if parsed is None:
            return False
        minx, miny, w, h = parsed

        if h <= 0:
            return False
        aspect = w / h
        # landscape and aspect > 1.8
        if w <= h or aspect <= 1.8:
            return False

        base_path = os.path.splitext(svg_path)[0]
        half_w = w / 2
        # We do NOT change the original viewBox/width/height; instead we clip the content
        # into left/right halves using clipPath rectangles in the same coordinate system.

        for i, (x_start, suffix) in enumerate([(minx, "_0"), (minx + half_w, "_1")]):
            tree_copy = ET.parse(svg_path)
            root_copy = tree_copy.getroot()

            # Determine SVG namespace
            if root_copy.tag.startswith("{"):
                ns_uri = root_copy.tag.split("}", 1)[0][1:]
                ns = f"{{{ns_uri}}}"
            else:
                ns = ""

            # Ensure there is a <defs> element
            defs = None
            for child in list(root_copy):
                if child.tag == f"{ns}defs":
                    defs = child
                    break
            if defs is None:
                defs = ET.Element(f"{ns}defs")
                # Insert defs at the top so it doesn't affect drawing order
                root_copy.insert(0, defs)

            clip_id = f"{base_name}{suffix}_clip"
            clip_path_el = ET.SubElement(defs, f"{ns}clipPath", id=clip_id)
            ET.SubElement(
                clip_path_el,
                f"{ns}rect",
                x=str(x_start),
                y=str(miny),
                width=str(half_w),
                height=str(h),
            )

            # Wrap all non-defs children in a group that uses the clip-path
            content_children = [c for c in list(root_copy) if c is not defs]
            if content_children:
                group = ET.Element(f"{ns}g", {"clip-path": f"url(#{clip_id})"})
                for c in content_children:
                    root_copy.remove(c)
                    group.append(c)
                root_copy.append(group)

            out_path = base_path + suffix + ".svg"
            try:
                ET.indent(tree_copy, space="  ")
            except AttributeError:
                pass
            tree_copy.write(out_path, encoding='unicode', xml_declaration=True)
            print(f"Split half saved to {out_path}")
        return True
    except Exception as e:
        print(f"Split failed for {svg_path}: {e}")
        return False


if __name__ == "__main__":

    dxf_folder = "/Users/weizenyang/Downloads/the wilds-dxf "
    dxf_folder = os.path.normpath(dxf_folder.strip())
    dxf_files = [f for f in os.listdir(dxf_folder) if f.endswith('.dxf')]

    unsplit_dir = os.path.join(dxf_folder, "d_s_unsplit")
    os.makedirs(unsplit_dir, exist_ok=True)

    for dxf_filename in dxf_files:
        dxf_file = os.path.join(dxf_folder, dxf_filename)
        print(f"Processing: {dxf_file}")

        doc = format_dimension_text(dxf_file)
        output_file = os.path.join(dxf_folder, f"{os.path.splitext(dxf_filename)[0]}.svg")

        dxf_layer_to_svg(doc, output_file, ["KT-Dim"])
        add_svg_comments(output_file, doc)

        base_name = os.path.splitext(dxf_filename)[0]
        did_split = split_svg_halves_if_needed(output_file, base_name)
        # Always put full d_s SVG in d_s_unsplit (root keeps only _0/_1 halves when split)
        if base_name.startswith("d_s"):
            output_abs = os.path.abspath(output_file)
            dest = os.path.join(unsplit_dir, os.path.basename(output_file))
            if os.path.isfile(output_abs):
                try:
                    shutil.move(output_abs, dest)
                    print(f"Moved to d_s_unsplit: {dest}")
                except Exception as e:
                    print(f"Failed to move {output_abs} to {dest}: {e}")
            else:
                print(f"Output file missing, skip move: {output_abs}")