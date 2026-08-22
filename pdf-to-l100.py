#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pdf-to-l100.py - Convertisseur, Pilote & Serveur d'impression direct L100 (100x150 mm)
Compatible Linux (USB direct /dev/usb/lp*) et Windows (Spooler Win32 RAW / USB).

Modes d'utilisation :
    1. Ligne de commande directe :
       python3 pdf-to-l100.py etiquette.pdf
       python3 pdf-to-l100.py etiquette.png
       python3 pdf-to-l100.py --test            # Imprime immédiatement une étiquette test Colissimo A4

    2. Mode Serveur local d'impression direct pour l'application Web :
       python3 pdf-to-l100.py --server         # Lance le serveur sur http://127.0.0.1:9123
       python3 pdf-to-l100.py --server --port 9123
"""

import os
import sys
import json
import base64
import random
import platform
import subprocess
import tempfile
import argparse
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("Erreur : La bibliothèque Pillow est requise. Installez-la avec : pip install Pillow")
    sys.exit(1)

# ============================================================
# CONFIGURATION MATÉRIELLE L100 (100 x 150 mm @ 203 DPI)
# ============================================================

DPI = 203

# Dimensions étiquette 100 x 150 mm à 203 DPI
WIDTH = 799
HEIGHT = 1199

# CPCL travaille par octets de 8 pixels (800 pixels = 100 octets)
BITMAP_WIDTH = 800
BYTE_WIDTH = 100

SYSTEM_OS = platform.system()  # 'Linux', 'Windows', 'Darwin'


# ============================================================
# GÉNÉRATEUR D'ÉTIQUETTE TEST COLISSIMO (A4 PAYSAGE)
# ============================================================

def generate_colissimo_test_image(
    buyer_name: str = "M. Thomas Petit",
    order_ref: str = "#4892",
    tracking_num: str = "6A148292048812",
    shop_name: str = "BOUTIQUE MARKET-HUB",
) -> Image.Image:
    """
    Génère en mémoire une étiquette Colissimo réaliste en A4 Paysage (1199 x 799 px).
    Permet de valider la chaîne : A4 Paysage -> Détection -> Rotation 90° -> Rendu 100x150 mm -> CPCL.
    """
    width = 1199
    height = 799
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)

    label_x = 40
    label_y = 30
    label_w = 1119
    label_h = 739

    # Cadre extérieur
    draw.rectangle([label_x, label_y, label_x + label_w, label_y + label_h], outline="black", width=4)

    # 1. En-tête Colissimo
    draw.rectangle([label_x, label_y, label_x + label_w, label_y + 90], fill="black")
    draw.text((label_x + 20, label_y + 20), "LA POSTE  |  COLISSIMO FRANCE", fill="white")
    draw.text((label_x + 720, label_y + 20), "LIVRAISON DOMICILE SANS SIGNATURE", fill="white")

    # 2. Routage postal
    draw.line([(label_x, label_y + 190), (label_x + label_w, label_y + 190)], fill="black", width=3)
    draw.line([(label_x + 600, label_y + 90), (label_x + 600, label_y + 190)], fill="black", width=3)

    draw.text((label_x + 20, label_y + 105), "ROUTAGE POSTAL :", fill="black")
    draw.text((label_x + 20, label_y + 135), "FR - 75011 - HUB 04", fill="black")

    draw.text((label_x + 620, label_y + 105), "POIDS BRUT : 0.350 KG", fill="black")
    draw.text((label_x + 620, label_y + 135), f"REF COMMANDE : {order_ref}", fill="black")
    draw.text((label_x + 620, label_y + 160), "DATE : 22/08/2026", fill="black")

    # 3. Adresses
    draw.line([(label_x, label_y + 440), (label_x + label_w, label_y + 440)], fill="black", width=3)
    draw.line([(label_x + 550, label_y + 190), (label_x + 550, label_y + 440)], fill="black", width=3)

    # Destinataire
    draw.text((label_x + 20, label_y + 205), "DESTINATAIRE :", fill="black")
    draw.text((label_x + 20, label_y + 240), f"{buyer_name.upper()}", fill="black")
    draw.text((label_x + 20, label_y + 280), "12 RUE DES LILAS - BATIMENT B", fill="black")
    draw.text((label_x + 20, label_y + 320), "CODE PORTE 4B12 - 2EME ETAGE", fill="black")
    draw.text((label_x + 20, label_y + 360), "75011 PARIS - FRANCE", fill="black")

    # Expéditeur
    draw.text((label_x + 570, label_y + 205), "EXPEDITEUR :", fill="black")
    draw.text((label_x + 570, label_y + 240), f"{shop_name.upper()}", fill="black")
    draw.text((label_x + 570, label_y + 280), "ATELIER VARIETY TOOLS", fill="black")
    draw.text((label_x + 570, label_y + 320), "45 RUE DE LA REPUBLIQUE", fill="black")
    draw.text((label_x + 570, label_y + 360), "69002 LYON - FRANCE", fill="black")

    # 4. Code-barres
    bc_x = label_x + 80
    bc_y = label_y + 465
    bc_w = 950
    bc_h = 160

    draw.rectangle([bc_x - 10, bc_y - 10, bc_x + bc_w + 10, bc_y + bc_h + 40], outline="black", width=1)

    rng = random.Random(42)
    curr_x = bc_x
    while curr_x < bc_x + bc_w:
        bar_w = rng.choice([2, 4, 6, 8])
        space_w = rng.choice([2, 4, 6])
        draw.rectangle([curr_x, bc_y, curr_x + bar_w, bc_y + bc_h], fill="black")
        curr_x += bar_w + space_w

    formatted_track = f"{tracking_num[0:2]} {tracking_num[2:6]} {tracking_num[6:10]} {tracking_num[10:]}"
    draw.text((bc_x + 320, bc_y + bc_h + 10), formatted_track, fill="black")

    # 5. Pied de page
    draw.text((label_x + 20, label_y + 700), "COLISSIMO LIVRAISON DIRECTE - PREUVE ELECTRONIQUE - FORMAT TEST L100", fill="black")

    return img


# ============================================================
# DÉTECTION ET CONVERSION PDF -> IMAGE
# ============================================================

def convert_pdf_to_image(pdf_path: str, output_prefix: str) -> str:
    """Convertit la première page du PDF en image PNG haute fidélité (203 DPI)."""
    # 1. Méthode pypdfium2 si disponible
    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(pdf_path)
        page = pdf[0]
        scale = DPI / 72.0
        bitmap = page.render(scale=scale)
        pil_image = bitmap.to_pil()
        out_png = f"{output_prefix}.png"
        pil_image.save(out_png)
        return out_png
    except ImportError:
        pass

    # 2. Méthode fitz (PyMuPDF) si disponible
    try:
        import fitz
        doc = fitz.open(pdf_path)
        page = doc[0]
        zoom = DPI / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat)
        out_png = f"{output_prefix}.png"
        pix.save(out_png)
        return out_png
    except ImportError:
        pass

    # 3. Méthode standard système pdftoppm (Poppler)
    try:
        subprocess.run(
            ["pdftoppm", "-f", "1", "-singlefile", "-r", str(DPI), "-png", pdf_path, output_prefix],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return f"{output_prefix}.png"
    except (subprocess.SubprocessError, FileNotFoundError):
        pass

    raise RuntimeError(
        "Impossible de convertir le PDF. Veuillez installer poppler-utils (pdftoppm) ou pypdfium2."
    )


# ============================================================
# TRAITEMENT & MISE EN PAGE DE L'IMAGE
# ============================================================

def prepare_image(img_or_path, auto_rotate: bool = True) -> Image.Image:
    """Adapte l'image au format 100 x 150 mm (800 x 1199 px @ 203 DPI)."""
    if isinstance(img_or_path, str):
        img = Image.open(img_or_path)
    else:
        img = img_or_path

    # Rotation si le document est plus large que haut (ex: A4 Paysage Colissimo)
    if auto_rotate and img.width > img.height:
        img = img.rotate(90, expand=True)

    # Conversion en niveaux de gris
    img = img.convert("L")

    # Redimensionnement vers 799 x 1199 px
    img = img.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)

    # Ajout du padding 1px blanc à droite pour atteindre 800 px (multiple de 8 pour CPCL)
    padded = Image.new("L", (BITMAP_WIDTH, HEIGHT), 255)
    padded.paste(img, (0, 0))

    return padded


# ============================================================
# CONVERSION BITMAP -> FLUX CPCL
# ============================================================

def image_to_cpcl(img: Image.Image) -> bytes:
    """Convertit l'image en bitmap 1-bit monochrome et génère les instructions CPCL L100."""
    bw_img = img.point(lambda p: 0 if p < 128 else 255, "1")
    pixels = bw_img.load()

    data = bytearray()
    for y in range(HEIGHT):
        for byte_x in range(BYTE_WIDTH):
            value = 0
            for bit in range(8):
                x = byte_x * 8 + bit
                if pixels[x, y] == 0:  # Noir = 1
                    value |= (0x80 >> bit)
            data.append(value)

    hex_data = data.hex().upper()

    header = (
        "! 0 200 200 1199 1\r\n"
        "PW 800\r\n"
        f"EG {BYTE_WIDTH} {HEIGHT} 0 0 "
    )
    footer = "\r\nFORM\r\nPRINT\r\n"

    return header.encode("ascii") + hex_data.encode("ascii") + footer.encode("ascii")


# ============================================================
# ENVOI PHYSIQUE À L'IMPRIMANTE (LINUX & WINDOWS)
# ============================================================

def find_linux_printer_port(preferred_port: str = None) -> str:
    """Détecte automatiquement le port USB de l'imprimante sous Linux."""
    if preferred_port and os.path.exists(preferred_port):
        return preferred_port

    candidate_ports = ["/dev/usb/lp0", "/dev/usb/lp1", "/dev/usb/lp2", "/dev/lp0", "/dev/lp1"]
    for port in candidate_ports:
        if os.path.exists(port):
            return port

    usb_dir = Path("/dev/usb")
    if usb_dir.exists():
        for p in sorted(usb_dir.glob("lp*")):
            return str(p)

    return "/dev/usb/lp0"


def send_to_linux_printer(cpcl_data: bytes, port: str):
    """Écrit directement les octets CPCL sur le périphérique USB Linux."""
    if not os.path.exists(port):
        raise FileNotFoundError(
            f"Imprimante thermique introuvable sur {port}.\n"
            f"Vérifiez que l'imprimante L100 est bien allumée et branchée en USB."
        )

    if not os.access(port, os.W_OK):
        raise PermissionError(
            f"Accès refusé au port {port}.\n"
            f"Ajoutez votre utilisateur au groupe 'lp' : sudo usermod -a -G lp $USER"
        )

    print(f"Envoi du flux CPCL vers {port} (Linux USB)...")
    with open(port, "wb") as printer:
        chunk_size = 4096
        for start in range(0, len(cpcl_data), chunk_size):
            chunk = cpcl_data[start:start + chunk_size]
            printer.write(chunk)
            printer.flush()
    print("✓ Impression terminée avec succès sur Linux.")


def send_to_windows_printer(cpcl_data: bytes, preferred_printer: str = None):
    """Envoie le flux CPCL brut au Spooler d'impression Windows en mode RAW."""
    try:
        import win32print

        printer_name = preferred_printer
        if not printer_name:
            printers = [p[2] for p in win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)]
            for p in printers:
                if any(k in p.lower() for k in ["l100", "thermal", "label", "etiquette", "shipping", "pos"]):
                    printer_name = p
                    break
            if not printer_name:
                printer_name = win32print.GetDefaultPrinter()

        print(f"Envoi du flux CPCL vers l'imprimante Windows : '{printer_name}'...")
        hPrinter = win32print.OpenPrinter(printer_name)
        try:
            hJob = win32print.StartDocPrinter(hPrinter, 1, ("Etiquette L100 MarketHub", None, "RAW"))
            try:
                win32print.StartPagePrinter(hPrinter)
                win32print.WritePrinter(hPrinter, cpcl_data)
                win32print.EndPagePrinter(hPrinter)
            finally:
                win32print.EndDocPrinter(hPrinter)
        finally:
            win32print.ClosePrinter(hPrinter)

        print("✓ Impression terminée avec succès sur Windows (via Win32 RAW Spooler).")
        return
    except ImportError:
        pass

    # Fallback Windows via fichier temporaire et commande système
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as tmp_bin:
        tmp_bin.write(cpcl_data)
        tmp_bin_path = tmp_bin.name

    try:
        printer_target = preferred_printer or "L100"
        print(f"Envoi via Spooler PowerShell vers '{printer_target}'...")
        ps_cmd = f"$bytes = [System.IO.File]::ReadAllBytes('{tmp_bin_path}'); Out-Printer -InputObject $bytes"
        res = subprocess.run(["powershell", "-Command", ps_cmd], capture_output=True, text=True)
        if res.returncode == 0:
            print("✓ Données envoyées à l'imprimante Windows.")
        else:
            subprocess.run(f'copy /B "{tmp_bin_path}" "\\\\localhost\\{printer_target}"', shell=True, check=True)
            print("✓ Données envoyées via partage imprimante.")
    finally:
        if os.path.exists(tmp_bin_path):
            try:
                os.remove(tmp_bin_path)
            except OSError:
                pass


def dispatch_print(cpcl_data: bytes, printer_name_or_port: str = None):
    """Achemine le flux CPCL vers le pilote matériel approprié selon l'OS."""
    if SYSTEM_OS == "Windows":
        send_to_windows_printer(cpcl_data, preferred_printer=printer_name_or_port)
    elif SYSTEM_OS == "Linux":
        port = find_linux_printer_port(printer_name_or_port)
        send_to_linux_printer(cpcl_data, port=port)
    else:
        port = printer_name_or_port or "/dev/usb/lp0"
        send_to_linux_printer(cpcl_data, port=port)


# ============================================================
# TRAITEMENT COMPLET D'IMPRESSION (FICHIER OU DONNÉES)
# ============================================================

def print_shipping_label(
    file_path: str = None,
    image_obj: Image.Image = None,
    printer_name_or_port: str = None,
    dry_run: bool = False,
    output_bin: str = None,
    no_rotate: bool = False,
) -> dict:
    with tempfile.TemporaryDirectory() as tmp_dir:
        if image_obj is not None:
            source_img = image_obj
        elif file_path:
            path = os.path.abspath(file_path)
            if not os.path.isfile(path):
                raise FileNotFoundError(f"Fichier introuvable : {path}")
            ext = Path(path).suffix.lower()
            if ext in [".png", ".jpg", ".jpeg", ".webp", ".bmp"]:
                source_img = Image.open(path)
            elif ext == ".pdf":
                prefix = os.path.join(tmp_dir, "label_render")
                rendered_png = convert_pdf_to_image(path, prefix)
                source_img = Image.open(rendered_png)
            else:
                raise ValueError(f"Format non supporté ({ext}). Formats acceptés : .pdf, .png, .jpg, .jpeg, .webp")
        else:
            # Étiquette DHL eCommerce officielle par défaut si présente
            dhl_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "DHL-eCommerce-Label-1-rotated.jpg")
            if os.path.isfile(dhl_path):
                print(f"Chargement de l'étiquette DHL test : {dhl_path}")
                source_img = Image.open(dhl_path)
            else:
                # Génération automatique de l'étiquette Colissimo de test
                source_img = generate_colissimo_test_image()

        # Calibration et rotation A4 -> 100x150 mm
        prepared = prepare_image(source_img, auto_rotate=not no_rotate)

        # Génération du flux CPCL
        cpcl_data = image_to_cpcl(prepared)

        if output_bin:
            with open(output_bin, "wb") as f_out:
                f_out.write(cpcl_data)

        if not dry_run:
            dispatch_print(cpcl_data, printer_name_or_port=printer_name_or_port)

        return {
            "ok": True,
            "status": "printed" if not dry_run else "simulated",
            "bytes_count": len(cpcl_data),
            "os": SYSTEM_OS,
        }


# ============================================================
# SERVEUR HTTP D'IMPRESSION DIRECTE (PORT 9123)
# ============================================================

class PrintHTTPHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()

        printer_target = find_linux_printer_port() if SYSTEM_OS == "Linux" else "L100 (Win32 Spooler)"
        resp = {
            "ok": True,
            "server": "MarketHub L100 Print Bridge",
            "os": SYSTEM_OS,
            "printer": printer_target,
            "status": "ready",
        }
        self.wfile.write(json.dumps(resp).encode("utf-8"))

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_length)

        try:
            payload = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        except Exception:
            payload = {}

        dry_run = payload.get("dry_run", False)
        printer = payload.get("printer", None)

        try:
            # 1. Si une image ou PDF base64 / data URL est fournie
            data_url = payload.get("data_url") or payload.get("image_base64") or payload.get("pdf_base64")
            if data_url and isinstance(data_url, str):
                if "," in data_url:
                    header, encoded = data_url.split(",", 1)
                else:
                    encoded = data_url

                raw_data = base64.b64decode(encoded)
                with tempfile.NamedTemporaryFile(suffix=".tmp", delete=False) as f_tmp:
                    f_tmp.write(raw_data)
                    f_tmp_path = f_tmp.name

                try:
                    # Tenter d'ouvrir comme image ou comme PDF
                    try:
                        img = Image.open(f_tmp_path)
                        result = print_shipping_label(image_obj=img, printer_name_or_port=printer, dry_run=dry_run)
                    except Exception:
                        result = print_shipping_label(file_path=f_tmp_path, printer_name_or_port=printer, dry_run=dry_run)
                finally:
                    if os.path.exists(f_tmp_path):
                        try:
                            os.remove(f_tmp_path)
                        except OSError:
                            pass
            elif payload.get("file_path"):
                result = print_shipping_label(file_path=payload["file_path"], printer_name_or_port=printer, dry_run=dry_run)
            else:
                # Priorité à l'étiquette DHL eCommerce présente dans le dossier
                dhl_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "DHL-eCommerce-Label-1-rotated.jpg")
                if os.path.isfile(dhl_file):
                    result = print_shipping_label(file_path=dhl_file, printer_name_or_port=printer, dry_run=dry_run)
                else:
                    # Génération de l'étiquette Colissimo de test
                    buyer = payload.get("buyer_name", "M. Thomas Petit")
                    order_ref = payload.get("order_ref", "#4892")
                    track = payload.get("tracking_number", "6A148292048812")
                    shop = payload.get("shop_name", "BOUTIQUE MARKET-HUB")
                    test_img = generate_colissimo_test_image(buyer_name=buyer, order_ref=order_ref, tracking_num=track, shop_name=shop)
                    result = print_shipping_label(image_obj=test_img, printer_name_or_port=printer, dry_run=dry_run)

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode("utf-8"))

        except Exception as e:
            self.send_response(500)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            err_resp = {"ok": False, "error": str(e)}
            self.wfile.write(json.dumps(err_resp).encode("utf-8"))

    def log_message(self, format, *args):
        # Affichage propre des requêtes
        print(f"[{SYSTEM_OS} Print Server] " + (format % args))


def run_server(port: int = 9123):
    server_address = ("127.0.0.1", port)
    httpd = HTTPServer(server_address, PrintHTTPHandler)
    print("=" * 65)
    print(f"🚀 Serveur d'impression direct L100 actif sur http://127.0.0.1:{port}")
    print(f"   Système d'exploitation : {SYSTEM_OS}")
    if SYSTEM_OS == "Linux":
        print(f"   Port matériel cible    : {find_linux_printer_port()}")
    else:
        print("   Mode Windows           : Spooler Win32 RAW (L100 / Thermal)")
    print("   En attente des ordres d'impression depuis l'application Web...")
    print("=" * 65)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt du serveur d'impression.")
        httpd.server_close()


# ============================================================
# POINT D'ENTRÉE CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="Pilote & Serveur d'impression direct pour imprimante thermique L100 (Linux & Windows)."
    )
    parser.add_argument("file", nargs="?", help="Chemin vers le fichier PDF ou Image à imprimer")
    parser.add_argument("--server", action="store_true", help="Lancer le serveur d'impression direct en arrière-plan (port 9123)")
    parser.add_argument("--port", type=int, default=9123, help="Port pour le serveur d'impression (défaut: 9123)")
    parser.add_argument("--test", action="store_true", help="Générer et imprimer directement une étiquette Colissimo test A4")
    parser.add_argument("--printer", "-p", help="Port ou nom de l'imprimante")
    parser.add_argument("--dry-run", action="store_true", help="Simuler la génération sans envoi physique")
    parser.add_argument("--output", "-o", help="Enregistrer le flux CPCL dans un fichier binaire")
    parser.add_argument("--no-rotate", action="store_true", help="Désactiver la rotation automatique 90°")

    args = parser.parse_args()

    if args.server:
        run_server(port=args.port)
        return

    if args.test or not args.file:
        print("Impression d'une étiquette test Colissimo A4 Paysage...")
        test_img = generate_colissimo_test_image()
        print_shipping_label(
            image_obj=test_img,
            printer_name_or_port=args.printer,
            dry_run=args.dry_run,
            output_bin=args.output,
            no_rotate=args.no_rotate,
        )
        return

    print_shipping_label(
        file_path=args.file,
        printer_name_or_port=args.printer,
        dry_run=args.dry_run,
        output_bin=args.output,
        no_rotate=args.no_rotate,
    )


if __name__ == "__main__":
    main()
