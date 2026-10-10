"""Remove a flat studio background (e.g. Apple's #F5F5F7) that touches the image edge, with soft edges."""
import numpy as np
from PIL import Image
from scipy import ndimage

def drop_flat_background(im: Image.Image, tol: int = 6, feather: int = 2, soft: float = 40.0) -> Image.Image:
    a = np.array(im.convert('RGBA')).astype(np.float32)
    rgb = a[..., :3]
    corners = np.array([rgb[0, 0], rgb[0, -1], rgb[-1, 0], rgb[-1, -1]])
    bg = np.median(corners, axis=0)
    diff = np.abs(rgb - bg).max(axis=2)
    near = diff <= tol
    labels, _ = ndimage.label(near)
    edge = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    bgmask = np.isin(labels, list(edge))
    band = ndimage.binary_dilation(bgmask, iterations=feather) & ~bgmask
    alpha = np.where(bgmask, 0.0, 1.0)
    al = np.clip(diff / soft, 0.0, 1.0)
    alpha = np.where(band, np.minimum(alpha, al), alpha)
    # un-mix the background from the soft edge pixels
    safe = np.maximum(alpha, 1e-3)[..., None]
    fg = np.where(band[..., None], (rgb - (1 - alpha[..., None]) * bg) / safe, rgb)
    out = np.dstack([np.clip(fg, 0, 255), alpha * 255 * (a[..., 3] / 255)]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')
