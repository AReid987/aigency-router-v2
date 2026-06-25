"""Monitoring — quota status check for Aigency Router."""

from __future__ import annotations

import json
import urllib.request
from typing import Callable

from .client import _build_headers, _default_urlopen

Urlopen = Callable[..., urllib.request.OpenerDirector]


def get_quota_status(
    base_url: str,
    api_key: str | None = None,
    urlopen: Urlopen | None = None,
) -> dict:
    """Fetch the current quota status from the Aigency Router gateway.

    Calls GET {base_url}/v1/admin/quota and returns the parsed JSON response.

    Args:
        base_url: Base URL of the Aigency Router gateway.
        api_key: Optional API key for authentication.
        urlopen: Injectable urlopen function (for testing).

    Returns:
        Parsed quota status dictionary.

    Raises:
        urllib.error.HTTPError: On non-2xx response.
        urllib.error.URLError: On connection errors.
    """
    url = f"{base_url.rstrip('/')}/v1/admin/quota"
    headers = _build_headers(api_key)
    open_fn = urlopen or _default_urlopen

    resp = open_fn(url, headers=headers, method="GET")
    body = resp.read()
    return json.loads(body.decode("utf-8"))
