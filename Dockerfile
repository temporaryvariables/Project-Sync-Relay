# rover-relay-starter — container image
# =============================================================================
# This Dockerfile packages your relay into a small, reproducible image so it runs
# the same way locally and on your hosting platform. Each step below becomes a
# cached layer; ordering them well means a code change doesn't reinstall deps.
# =============================================================================

# Base image: Node.js 20 on Alpine Linux. "alpine" is a tiny distro, so the final
# image stays small and starts fast. It includes `node` and `npm` ready to use.
FROM node:20-alpine

# Set the working directory inside the container. Every command after this runs
# from /app, and our files live here. Docker creates the folder if it's missing.
WORKDIR /app

# Copy ONLY the manifest first (not the whole project). Because Docker caches
# layers, the expensive `npm install` below is only re-run when package.json
# actually changes — editing server.js alone reuses the cached dependencies.
COPY package.json ./

# Install production dependencies. `--omit=dev` skips devDependencies (test/build
# tooling) so the image carries just what's needed to run the server.
RUN npm install --omit=dev

# Now copy the rest of the source (server.js, etc.) into the image. This is a
# separate, later layer so source edits don't bust the dependency cache above.
COPY . .

# Document that the app listens on port 4000. EXPOSE is informational metadata —
# it doesn't publish the port by itself; your platform maps it (and reads the
# PORT env var, which the server honors). Make sure Coolify's "Ports Exposes"
# is set to 4000 to match, otherwise the proxy returns "Bad Gateway".
EXPOSE 4000

# The default command run when the container starts: launch the server with Node.
# Using the exec form (JSON array) makes Node the main process so it receives
# stop/restart signals cleanly.
CMD ["node", "server.js"]
