# Psi4 + JSME + 3Dmol.js — imagen para VPS con Dokploy
#
# Contiene: Psi4 1.11, RDKit y Node.js 22 (todo desde conda-forge) + la aplicación web.
# Puerto interno: 3000 (Dokploy/Traefik lo publica con HTTPS en su dominio).
# Volumen recomendado: /app/datos  (resultados de los cálculos)
# Variables: ver README.md (CLAVE_ACCESO, PSI4_HILOS, PSI4_MEMORIA, MAX_ATOMOS, ...)

FROM mambaorg/micromamba:2.10.0

# 1) Química: Psi4, RDKit, Python y Node.js
COPY --chown=$MAMBA_USER:$MAMBA_USER environment.yml /tmp/environment.yml
RUN micromamba install -y -n base -f /tmp/environment.yml \
 && micromamba clean --all --yes

ENV PATH=/opt/conda/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=production \
    PUERTO=3000 \
    PYTHON=/opt/conda/bin/python \
    CARPETA_DATOS=/app/datos

# 2) Aplicación
USER root
RUN mkdir -p /app/datos && chown -R $MAMBA_USER:$MAMBA_USER /app
USER $MAMBA_USER
WORKDIR /app

COPY --chown=$MAMBA_USER:$MAMBA_USER package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=$MAMBA_USER:$MAMBA_USER servidor.js ./
COPY --chown=$MAMBA_USER:$MAMBA_USER python ./python
COPY --chown=$MAMBA_USER:$MAMBA_USER public ./public

# Comprobación en la construcción: Psi4 y RDKit importan correctamente
RUN python python/version.py < /dev/null

VOLUME ["/app/datos"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PUERTO||3000)+'/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "servidor.js"]
