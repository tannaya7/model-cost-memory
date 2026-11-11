"""Who is signed in, and which projects they own (technical plan 3.14).

People sign in with Google on the server (authlib); the session is a signed, httpOnly, SameSite=Lax
cookie, so the web app never holds a token. The SDK and scripts keep using the project key.
"""
