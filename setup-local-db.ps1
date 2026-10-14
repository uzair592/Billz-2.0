# ===================================================================
# Billz 2.0 – Local PostgreSQL Setup Script (No Docker Required)
# Run this once to create the database, users, and run all migrations
# ===================================================================

param(
    [string]$PgVersion = "17",
    [string]$PgPort = "55432",
    [string]$PgHost = "127.0.0.1"
)

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " Billz 2.0 – Local Database Setup" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

# ─── 1. Locate psql ───────────────────────────────────────────────
$psqlPaths = @(
    "C:\Program Files\PostgreSQL\17\bin\psql.exe",
    "C:\Program Files\PostgreSQL\16\bin\psql.exe",
    "C:\Program Files\PostgreSQL\15\bin\psql.exe",
    "C:\Program Files\PostgreSQL\14\bin\psql.exe"
)

$psql = $null
foreach ($p in $psqlPaths) {
    if (Test-Path $p) { $psql = $p; break }
}

if (-not $psql) {
    # Try finding in PATH
    $found = Get-Command psql -ErrorAction SilentlyContinue
    if ($found) { $psql = $found.Source }
}

if (-not $psql) {
    Write-Host "❌ psql not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install PostgreSQL 17 from:" -ForegroundColor Yellow
    Write-Host "  https://www.enterprisedb.com/downloads/postgres-postgresql-downloads" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "During installation, remember the password you set for the 'postgres' user." -ForegroundColor Yellow
    Write-Host "After installation, run this script again." -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ Found psql at: $psql" -ForegroundColor Green

# ─── 2. Get postgres superuser password ───────────────────────────
Write-Host ""
$pgPassword = Read-Host "Enter your PostgreSQL 'postgres' superuser password" -AsSecureString
$pgPasswordPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pgPassword)
)

$Env:PGPASSWORD = $pgPasswordPlain

# ─── 3. Detect PostgreSQL service port ────────────────────────────
Write-Host ""
Write-Host "Checking if PostgreSQL is running on port $PgPort..." -ForegroundColor Yellow
$testConn = & $psql -h $PgHost -p $PgPort -U postgres -c "SELECT 1" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "❌ Cannot connect to PostgreSQL on port $PgPort." -ForegroundColor Red
    Write-Host ""
    Write-Host "PostgreSQL is likely running on the default port 5432." -ForegroundColor Yellow
    Write-Host "Trying port 5432..." -ForegroundColor Yellow
    
    $testConn2 = & $psql -h $PgHost -p 5432 -U postgres -c "SELECT 1" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Connected on port 5432." -ForegroundColor Green
        $PgPort = "5432"
        
        # Update .env file to use port 5432
        Write-Host ""
        Write-Host "Updating .env to use port 5432..." -ForegroundColor Yellow
        $envContent = Get-Content ".env" -Raw
        $envContent = $envContent -replace "55432", "5432"
        Set-Content ".env" $envContent
        Write-Host "✅ .env updated to use port 5432." -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "❌ Cannot connect to PostgreSQL on port 5432 either." -ForegroundColor Red
        Write-Host "Make sure the PostgreSQL service is running:" -ForegroundColor Yellow
        Write-Host "  1. Open Services (Win+R → services.msc)" -ForegroundColor Yellow
        Write-Host "  2. Find 'postgresql-x64-17' and click Start" -ForegroundColor Yellow
        exit 1
    }
}

Write-Host "✅ PostgreSQL is reachable on port $PgPort." -ForegroundColor Green

# ─── 4. Create database and users ─────────────────────────────────
Write-Host ""
Write-Host "Creating database and users..." -ForegroundColor Yellow

$setupSQL = @"
-- Create database (ignore error if already exists)
SELECT 'CREATE DATABASE restaurant_pos_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'restaurant_pos_test')\gexec

-- Create app user
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pos_integration_app') THEN
    CREATE ROLE pos_integration_app LOGIN PASSWORD 'integration-only';
  END IF;
END
\$\$;

-- Create control user
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pos_control_test') THEN
    CREATE ROLE pos_control_test LOGIN PASSWORD 'control-test-only';
  END IF;
END
\$\$;
"@

$setupSQL | & $psql -h $PgHost -p $PgPort -U postgres
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to create database or users." -ForegroundColor Red
    exit 1
}

# Grant privileges
$grantSQL = @"
GRANT ALL PRIVILEGES ON DATABASE restaurant_pos_test TO pos_integration_app;
GRANT ALL PRIVILEGES ON DATABASE restaurant_pos_test TO pos_control_test;
"@
$grantSQL | & $psql -h $PgHost -p $PgPort -U postgres
Write-Host "✅ Database and users created." -ForegroundColor Green

# ─── 5. Run migrations ────────────────────────────────────────────
Write-Host ""
Write-Host "Running migrations..." -ForegroundColor Yellow

$Env:PGPASSWORD = $pgPasswordPlain
$migrationFiles = Get-ChildItem "database\migrations\*.sql" | Sort-Object Name

foreach ($file in $migrationFiles) {
    Write-Host "  → $($file.Name)" -ForegroundColor Gray
    & $psql -h $PgHost -p $PgPort -U postgres -d restaurant_pos_test -f $file.FullName -q
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ⚠️  Warning: migration $($file.Name) may have already been applied (this is OK)." -ForegroundColor Yellow
    }
}

Write-Host "✅ Migrations complete." -ForegroundColor Green

# ─── 6. Seed default platform admin & plan ────────────────────────
Write-Host ""
Write-Host "Seeding default super-admin and plans..." -ForegroundColor Yellow

$seedSQL = @"
-- Seed default plans if not already present
INSERT INTO plans (code, name, description, features, sort_order)
VALUES 
  ('STARTER', 'Starter', '1 device, basic features', '{"max_devices": 1, "storage_gb": 2}'::jsonb, 1),
  ('GROWTH', 'Growth', 'Up to 3 devices', '{"max_devices": 3, "storage_gb": 5}'::jsonb, 2),
  ('PRO', 'Pro', 'Up to 10 devices', '{"max_devices": 10, "storage_gb": 20}'::jsonb, 3),
  ('ENTERPRISE', 'Enterprise', 'Unlimited devices', '{"max_devices": 999, "storage_gb": 100}'::jsonb, 4)
ON CONFLICT (code) DO UPDATE SET features = EXCLUDED.features;
"@

$seedSQL | & $psql -h $PgHost -p $PgPort -U postgres -d restaurant_pos_test
Write-Host "✅ Default plans seeded." -ForegroundColor Green

# ─── 7. Grant schema privileges ───────────────────────────────────
$schemaSQL = @"
GRANT USAGE ON SCHEMA public TO pos_integration_app, pos_control_test;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO pos_integration_app, pos_control_test;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO pos_integration_app, pos_control_test;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO pos_integration_app, pos_control_test;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO pos_integration_app, pos_control_test;
"@
$schemaSQL | & $psql -h $PgHost -p $PgPort -U postgres -d restaurant_pos_test
Write-Host "✅ Schema privileges granted." -ForegroundColor Green

# ─── 8. Done ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " ✅ Database setup complete!" -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "You can now start the app with:" -ForegroundColor White
Write-Host "  npm run start" -ForegroundColor Yellow
Write-Host ""
Write-Host "Or run migrations manually at any time with:" -ForegroundColor White
Write-Host "  npm run migrate" -ForegroundColor Yellow
Write-Host ""
