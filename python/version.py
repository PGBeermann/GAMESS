"""Informa las versiones de Psi4 y RDKit instaladas y si PCMSolver está disponible
(lo usa servidor.js al arrancar; con --exigir-pcm, la construcción de Docker falla si falta PCM)."""
import json
import sys

info = {}
try:
    import psi4
    info["psi4"] = psi4.__version__
    try:
        import pcmsolver  # noqa: F401  (módulo de Python que usa psi4.pcm_helper)
        info["pcm"] = bool(psi4.addons("pcmsolver"))
    except Exception as e:  # noqa: BLE001
        info["pcm"] = False
        info["error_pcm"] = str(e)
except Exception as e:  # noqa: BLE001
    info["psi4"] = None
    info["pcm"] = False
    info["error_psi4"] = str(e)
try:
    import rdkit
    info["rdkit"] = rdkit.__version__
except Exception as e:  # noqa: BLE001
    info["rdkit"] = None
    info["error_rdkit"] = str(e)
sys.stdin.read()
print(json.dumps(info))
if "--exigir-pcm" in sys.argv and not info.get("pcm"):
    sys.exit(f"PCMSolver no está disponible en Psi4: {info.get('error_pcm', 'addons(pcmsolver) = False')}")
