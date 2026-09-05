#!/usr/bin/env python3
import sys
import os
import io

def convert_heic_to_jpg(input_path, output_path, quality=95):
    try:
        import pillow_heif
        from PIL import Image, ImageCms, ImageOps
    except ImportError:
        sys.stderr.write("pillow-heif or PIL is not installed.\n")
        sys.exit(2)

    try:
        # Open with explicit HDR to 8-bit mapping (prevents green/red rectangular artifacts on Apple HEIC)
        heif_file = pillow_heif.open_heif(input_path, convert_hdr_to_8bit=True)
        image = heif_file.to_pillow()

        # Handle EXIF orientation
        try:
            image = ImageOps.exif_transpose(image) or image
        except Exception:
            pass

        # Preserve vibrant colors: convert Apple Display P3 / Wide Gamut ICC profile to standard sRGB
        icc_profile = image.info.get("icc_profile")
        if icc_profile:
            try:
                input_profile = ImageCms.getOpenProfile(io.BytesIO(icc_profile))
                srgb_profile = ImageCms.createProfile("sRGB")
                transformed = ImageCms.profileToProfile(image, input_profile, srgb_profile, outputMode="RGB")
                if transformed is not None:
                    transformed.info = image.info.copy()
                    image = transformed
            except Exception:
                pass

        # Normalize color channels to standard sRGB
        if image.mode != "RGB":
            image = image.convert("RGB")

        # Save JPEG with 4:4:4 subsampling (subsampling=0) and high quality
        save_kwargs = {
            "quality": int(quality),
            "subsampling": 0,
        }

        if "exif" in image.info and image.info["exif"]:
            save_kwargs["exif"] = image.info["exif"]

        image.save(output_path, "JPEG", **save_kwargs)
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(f"Conversion error: {str(e)}\n")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.stderr.write("Usage: python3 convert_heic.py <input.heic> <output.jpg> [quality]\n")
        sys.exit(1)
    
    in_file = sys.argv[1]
    out_file = sys.argv[2]
    q_val = sys.argv[3] if len(sys.argv) > 3 else "95"
    convert_heic_to_jpg(in_file, out_file, q_val)

