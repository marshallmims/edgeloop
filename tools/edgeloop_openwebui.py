"""
title: EdgeLoop
author: edgeloop
version: 1.0
description: Control an EdgeLoop session from the agent link. Read the heart rate, play style, endgame, and toys, then send one command.
"""

import json
from urllib.request import Request, urlopen


def _link(link: str) -> str:
    text = (link or "").strip()
    if not text.startswith("https://") and not text.startswith("http://"):
        raise ValueError("Paste the full agent link from the EdgeLoop page.")
    return text.split()[0]


def _get(link: str) -> str:
    with urlopen(_link(link), timeout=15) as response:
        return response.read().decode("utf-8")


def _post(link: str, command: dict) -> str:
    body = json.dumps(command).encode("utf-8")
    request = Request(_link(link), data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=15) as response:
        return response.read().decode("utf-8")


class Tools:
    def session(self, link: str) -> str:
        """
        Read an EdgeLoop agent link. Returns the menu, heart rate, play style,
        endgame, session length, toy list, and the speeds the toys are being sent.
        Pass the full link the wearer copied from Share Control.
        """
        return _get(link)

    def command(self, link: str, command: str) -> str:
        """
        Send one EdgeLoop command to the agent link. command is a JSON object.
        Examples: {"type":"MODE_CHANGE","mode":"milker"}
        {"type":"SESSION_STATE","status":"RUNNING"}
        {"type":"ENDGAME","endgame":"rampdown"}
        {"type":"DURATION","mode":"fixed","minutes":30}
        {"type":"INTENSITY","value":70}
        {"type":"ORGASM_TOGGLE"}
        {"type":"SESSION_STATE","status":"IDLE"}
        Duration applies only before the session starts. Heart rate is read
        from session, never set here.
        """
        try:
            payload = json.loads(command)
        except json.JSONDecodeError:
            return json.dumps({"ok": False, "error": "command must be JSON."})
        if not isinstance(payload, dict):
            return json.dumps({"ok": False, "error": "command must be a JSON object."})
        return _post(link, payload)
