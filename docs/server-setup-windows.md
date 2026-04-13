# MCP Server Setup (Remote) - Windows Server

## Architecture
The MCP server runs as a **Windows service** (via NSSM) on a Windows VM where Tally Prime is running. Deployments are automated via **GitHub Actions** using a self-hosted runner on the same VM.

```
Push to main → GitHub Actions → Self-hosted runner on VM → git pull + build + restart service
```

## Pre-requisites
- Windows Server / Windows 10+ VM with Tally Prime running
- Node.js >= 21 installed
- Git installed
- Tally Prime XML server enabled on port 9000

## One-Time VM Setup (via RDP)

### 1. Clone the repo & build
```powershell
cd C:\
git clone https://github.com/jain-t/tally-mcp-server.git
cd tally-mcp-server
npm install
npx tsc
```

### 2. Create `.env` file
```powershell
# C:\tally-mcp-server\.env
PASSWORD=your_secure_password
MCP_DOMAIN=http://34.47.203.53:3000
CONNECTION_STRING=
```

### 3. Install NSSM & register as Windows service
Run the setup script **as Administrator**:
```powershell
powershell -ExecutionPolicy Bypass -File C:\tally-mcp-server\scripts\setup-windows.ps1
```

This will:
- Install NSSM (if not present)
- Register `TallyMCP` as a Windows service
- Configure auto-start on boot, log rotation
- Load environment variables from `.env`
- Start the service

### 4. Install GitHub Actions self-hosted runner
Go to **GitHub repo → Settings → Actions → Runners → New self-hosted runner** and follow the Windows instructions. Summary:

```powershell
mkdir C:\actions-runner && cd C:\actions-runner
# Download and extract the runner (URL from GitHub settings page)
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.XXX.X/actions-runner-win-x64-2.XXX.X.zip -OutFile runner.zip
Expand-Archive -Path runner.zip -DestinationPath .
./config.cmd --url https://github.com/jain-t/tally-mcp-server --token YOUR_TOKEN
./run.cmd  # or install as service: ./svc.cmd install && ./svc.cmd start
```

**Important:** Install the runner as a service (`svc.cmd install`) so it survives reboots and RDP disconnects.

## Deployment (Automated)
Once the above is set up, every push to `main` automatically:
1. Pulls latest code on the VM
2. Runs `npm install`
3. Builds TypeScript (`npx tsc`)
4. Restarts the `TallyMCP` service

You can also trigger a deploy manually from **GitHub → Actions → Deploy to Tally MCP Server → Run workflow**.

## Useful Commands
```powershell
nssm status TallyMCP       # Check service status
nssm restart TallyMCP      # Restart
nssm stop TallyMCP         # Stop
nssm start TallyMCP        # Start
nssm edit TallyMCP         # Edit config (GUI)
Get-Content C:\tally-mcp-server\logs\service-stderr.log -Tail 50   # View recent logs
```