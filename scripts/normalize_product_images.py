"""
Normalize product images to one frame: 1200x800 transparent canvas, the device trimmed to its
visible pixels, scaled so its height is exactly CANVAS_H - 2*MARGIN_Y (fixed top/bottom margin),
centred horizontally. Opaque white backgrounds touching the edge are made transparent first.
"""
import json, sys
import numpy as np
from PIL import Image
from scipy import ndimage

CANVAS_W, CANVAS_H, MARGIN_Y, MIN_MARGIN_X = 1200, 800, 64, 40
CONTENT_H = CANVAS_H - 2 * MARGIN_Y

def drop_white_background(im: Image.Image) -> Image.Image:
    a = np.array(im.convert('RGBA'))
    rgb, alpha = a[..., :3].astype(int), a[..., 3]
    whiteish = (rgb.min(axis=2) >= 244) & (alpha > 0)
    labels, _ = ndimage.label(whiteish)
    edge = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    if edge:
        bg = np.isin(labels, list(edge))
        a[..., 3] = np.where(bg, 0, alpha)
    return Image.fromarray(a, 'RGBA')

def normalize(src: str, dst: str) -> dict:
    im = Image.open(src).convert('RGBA')
    bbox = im.split()[-1].point(lambda v: 255 if v > 8 else 0).getbbox()
    if bbox == (0, 0, im.width, im.height) or (bbox[0] == 0 and bbox[2] == im.width):
        im = drop_white_background(im)  # opaque/letterboxed white background
        bbox = im.split()[-1].point(lambda v: 255 if v > 8 else 0).getbbox()
    dev = im.crop(bbox)
    scale = CONTENT_H / dev.height
    w = round(dev.width * scale)
    if w > CANVAS_W - 2 * MIN_MARGIN_X:
        raise SystemExit(f'{src}: too wide for a fixed vertical margin ({w}px)')
    dev = dev.resize((w, CONTENT_H), Image.LANCZOS)
    canvas = Image.new('RGBA', (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    canvas.paste(dev, ((CANVAS_W - w) // 2, MARGIN_Y), dev)
    canvas.save(dst, 'WEBP', quality=90, method=6)
    return {'src_px': list(im.size), 'device_px': [bbox[2] - bbox[0], bbox[3] - bbox[1]], 'upscale': round(scale, 2)}

if __name__ == '__main__':
    jobs = json.load(open(sys.argv[1]))
    report = {}
    for model, j in jobs.items():
        report[model] = normalize(j['file'], j['out']) | {'source': j['source']}
        print(model, report[model]['device_px'], 'x', report[model]['upscale'])
    json.dump(report, open('normalize_report.json', 'w'), indent=1)
