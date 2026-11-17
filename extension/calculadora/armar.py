# Arma el ZIP de la extensión "Calculadora de precio y ganancia" para subir a Chrome Web Store.
# Uso: python3 extension/calculadora/armar.py <carpeta de salida>
import sys, os, shutil, zipfile
from PIL import Image
AQUI = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[1])
shutil.rmtree(OUT, ignore_errors=True)
shutil.copytree(os.path.join(AQUI, 'src'), OUT)
os.makedirs(os.path.join(OUT, 'iconos'))
ico = Image.open(os.path.join(AQUI, '..', '..', 'public', 'icon-512.png')).convert('RGBA')
for t in (16, 32, 48, 128):
    ico.resize((t, t), Image.LANCZOS).save(os.path.join(OUT, 'iconos', f'{t}.png'))
z = OUT.rstrip('/') + '.zip'
if os.path.exists(z): os.remove(z)
with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf:
    for raiz, _, archivos in os.walk(OUT):
        for a in archivos:
            ruta = os.path.join(raiz, a); zf.write(ruta, os.path.relpath(ruta, OUT))
print('listo', z, round(os.path.getsize(z) / 1024), 'KB')
