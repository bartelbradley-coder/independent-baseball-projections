#!/usr/bin/env python3
import http.server, os, sys

port = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else 7790))
root = os.path.dirname(os.path.abspath(__file__))
os.chdir(root)
http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler, port=port, bind="127.0.0.1")
