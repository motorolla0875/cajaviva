#!/bin/bash
# Guías automáticas de CajaViva (cajaviva.app/guias/). Usa la misma clave de Groq que tujuego.
# Instalar o actualizar:  bash /root/cajaviva/guias/instalar.sh
set -e
cd /root/cajaviva && git pull -q
mkdir -p /root/cajaviva-guias /root/cajaviva/public/guias
set -a; [ -f /root/tujuego.env ] && . /root/tujuego.env; [ -f /root/cajaviva-guias/.env ] && . /root/cajaviva-guias/.env; set +a
if ! grep -qE "^(GROQ|XAI|GEMINI)_API_KEY=." /root/tujuego.env /root/cajaviva-guias/.env 2>/dev/null; then
  echo "Falta la clave de Groq (GROQ_API_KEY) en /root/tujuego.env"; exit 1
fi
pm2 delete cajaviva-guias >/dev/null 2>&1 || true
DIR_CONFIG=/root/cajaviva/guias/config.json DIR_POR_DIA=${DIR_POR_DIA:-6} \
  pm2 start /root/cajaviva/guias/generador.js --name cajaviva-guias --max-memory-restart 150M --update-env
pm2 save >/dev/null
echo "== listo: guías de CajaViva en marcha (ver: pm2 logs cajaviva-guias) =="
