"""enetdiag - read-only BMW ENET (HSFZ) discovery for the bmw-g20-idrive-rgb project.

Runs on the Windows laptop over a USB-C Ethernet adapter and an ENET cable. It only ever sends
UDS ReadDataByIdentifier (0x22) requests (policy.py refuses everything else before the socket),
finds the gateway, lists the control units, identifies the MGU and the BDC, reads the BDC's
interior-light identifiers documented for BDC_G05 (uds.py), and writes a redacted JSON report
plus a structured log you can share for analysis.

The HSFZ transport is adapted from cauliflowermossgrape/idrive7-8-ssh-root (mgu7/hsfz.py,
mgu7/discovery.py, public domain / Unlicense). Standard library only.
"""
__version__ = "0.1.0"
