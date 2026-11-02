"""Informa las versiones de Psi4 y RDKit instaladas (lo usa servidor.js al arrancar)."""
import json
import sys

info = {}
try:
    import psi4
    info["psi4"] = psi4.__version__
except Exception as e:  # noqa: BLE001
    info["psi4"] = None
    info["error_psi4"] = str(e)
try:
    import rdkit
    info["rdkit"] = rdkit.__version__
except Exception as e:  # noqa: BLE001
    info["rdkit"] = None
    info["error_rdkit"] = str(e)
sys.stdin.read()
print(json.dumps(info))
