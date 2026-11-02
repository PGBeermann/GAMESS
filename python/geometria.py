"""Convierte la molécula dibujada en JSME (molfile o SMILES) en una geometría 3D.

Lee un JSON por la entrada estándar:  {"molfile": "...", "smiles": "...", "max_atomos": 40}
Escribe un JSON por la salida estándar con la geometría (XYZ en Å), el molfile 3D,
la fórmula, la carga formal y la multiplicidad sugerida.

Pasos: RDKit lee la estructura → añade hidrógenos → genera coordenadas 3D (ETKDG)
→ pre-optimiza con el campo de fuerza MMFF94 (o UFF si MMFF no tiene parámetros).
"""
import json
import sys

from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem, rdMolDescriptors

RDLogger.DisableLog("rdApp.*")


def responder(datos, codigo=0):
    sys.stdout.write(json.dumps(datos))
    sys.stdout.flush()
    sys.exit(codigo)


def leer_molecula(datos):
    mol = None
    molfile = (datos.get("molfile") or "").strip("\n")
    smiles = (datos.get("smiles") or "").strip()
    if molfile:
        mol = Chem.MolFromMolBlock(molfile, sanitize=True, removeHs=False)
    if mol is None and smiles:
        mol = Chem.MolFromSmiles(smiles)
    return mol


def desde_xyz(datos):
    """Geometría leída de un archivo (.in o .xyz): se conservan las coordenadas tal cual.

    RDKit sólo deduce los enlaces (para el visor 3D y el SMILES) y genera un dibujo 2D
    para el editor JSME. Si no logra asignar órdenes de enlace, usa sólo la conectividad.
    """
    from rdkit.Chem import rdDetermineBonds

    xyz = datos["xyz"].strip()
    carga = int(datos.get("carga") or 0)
    lineas = xyz.splitlines()
    mol = Chem.MolFromXYZBlock(f"{len(lineas)}\narchivo\n{xyz}\n")
    if mol is None:
        responder({"ok": False, "error": "No se pudieron leer las coordenadas del archivo."}, 1)
    aviso = ""
    try:
        rdDetermineBonds.DetermineBonds(mol, charge=carga)
    except Exception:
        try:
            rdDetermineBonds.DetermineConnectivity(mol)
            aviso = "No se pudieron deducir los órdenes de enlace: el dibujo 2D muestra sólo la conectividad."
        except Exception:
            aviso = "No se pudo deducir la conectividad; el editor 2D no se actualiza."
    electrones = sum(a.GetAtomicNum() for a in mol.GetAtoms()) - carga
    smiles, mol2d, molblock = "", "", ""
    try:
        molblock = Chem.MolToMolBlock(mol)
        sin_h = Chem.RemoveHs(mol, sanitize=False)
        try:
            Chem.SanitizeMol(sin_h)
            smiles = Chem.MolToSmiles(sin_h)
        except Exception:
            pass
        copia = Chem.Mol(sin_h)
        AllChem.Compute2DCoords(copia)
        mol2d = Chem.MolToMolBlock(copia)
    except Exception:
        pass
    try:
        formula = rdMolDescriptors.CalcMolFormula(mol)
        masa = round(rdMolDescriptors.CalcExactMolWt(mol), 4)
    except Exception:
        formula, masa = "", None
    responder({
        "ok": True, "xyz": xyz, "molblock": molblock, "mol2d": mol2d, "smiles": smiles,
        "formula": formula, "masa": masa, "natomos": mol.GetNumAtoms(), "electrones": electrones,
        "carga": carga, "multiplicidad": int(datos.get("multiplicidad") or 1),
        "campo_fuerza": "archivo", "aviso": aviso,
    })


def main():
    try:
        datos = json.load(sys.stdin)
    except Exception:
        responder({"ok": False, "error": "Entrada no válida."}, 1)

    if datos.get("xyz"):
        desde_xyz(datos)

    max_atomos = int(datos.get("max_atomos") or 40)
    mol = leer_molecula(datos)
    if mol is None:
        responder({"ok": False, "error": "RDKit no pudo interpretar la estructura. Revise valencias y cargas."}, 1)
    if mol.GetNumAtoms() == 0:
        responder({"ok": False, "error": "La molécula está vacía: dibuje una estructura en el editor."}, 1)

    mol = Chem.AddHs(mol)
    n = mol.GetNumAtoms()
    if n > max_atomos:
        responder({"ok": False, "error": f"La molécula tiene {n} átomos (con H). El máximo permitido es {max_atomos}."}, 1)

    if n == 1:
        conf = Chem.Conformer(1)
        conf.SetAtomPosition(0, (0.0, 0.0, 0.0))
        mol.RemoveAllConformers()
        mol.AddConformer(conf, assignId=True)
        campo = "ninguno"
    else:
        params = AllChem.ETKDGv3()
        params.randomSeed = 61803
        if AllChem.EmbedMolecule(mol, params) < 0:
            params.useRandomCoords = True
            if AllChem.EmbedMolecule(mol, params) < 0:
                responder({"ok": False, "error": "No se pudo generar una geometría 3D para esta estructura."}, 1)
        if AllChem.MMFFHasAllMoleculeParams(mol):
            AllChem.MMFFOptimizeMolecule(mol, maxIters=2000)
            campo = "MMFF94"
        else:
            AllChem.UFFOptimizeMolecule(mol, maxIters=2000)
            campo = "UFF"

    conf = mol.GetConformer()
    lineas = []
    electrones = 0
    for atomo in mol.GetAtoms():
        p = conf.GetAtomPosition(atomo.GetIdx())
        lineas.append(f"{atomo.GetSymbol():<2s} {p.x:14.8f} {p.y:14.8f} {p.z:14.8f}")
        electrones += atomo.GetAtomicNum()

    carga = Chem.GetFormalCharge(mol)
    radicales = sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms())
    multiplicidad = radicales + 1
    electrones -= carga
    # Si la paridad no cuadra (p. ej. un radical dibujado sin marcar), se corrige a doblete.
    if (electrones + multiplicidad - 1) % 2 != 0:
        multiplicidad = 2

    responder({
        "ok": True,
        "xyz": "\n".join(lineas),
        "molblock": Chem.MolToMolBlock(mol),
        "smiles": Chem.MolToSmiles(Chem.RemoveHs(mol)),
        "formula": rdMolDescriptors.CalcMolFormula(mol),
        "masa": round(rdMolDescriptors.CalcExactMolWt(mol), 4),
        "natomos": n,
        "electrones": electrones,
        "carga": carga,
        "multiplicidad": multiplicidad,
        "campo_fuerza": campo,
    })


if __name__ == "__main__":
    main()
