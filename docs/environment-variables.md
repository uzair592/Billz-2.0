# Environment Variables Reference

Reference for production environment configuration. Placeholders only; no secrets inside tracked files.

| Variable Name | Description | Example / Default | Required |
| --- | --- | --- | --- |
| `NODE_ENV` | Application environment mode | `production` | Yes |
| `HOST` | HTTP listener bind host | `0.0.0.0` | Yes |
| `PORT` | HTTP listener bind port | `10000` | Yes |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://user:pass@host:5432/dbname` | Yes |
| `DATABASE_SSL_MODE` | PostgreSQL SSL enforcement | `require` | Yes |
| `DATABASE_SSL_CA` | CA certificate path if required | `/path/to/ca.pem` | Optional |
| `SESSION_SECRET` | Secret key for signing session cookies | `<random-32-byte-hex>` | Yes |
| `PASSWORD_PEPPER` | Pepper string for password hashing | `<random-32-byte-hex>` | Yes |
| `TRUSTED_ORIGINS` | Comma-separated CORS origins | `https://pilot.example.com` | Yes |
| `PAYMENT_PROVIDER` | Payment integration provider | `stripe` | Yes |
| `STRIPE_SECRET_KEY` | Stripe secret key (test/live) | `sk_test_...` | Yes |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | `whsec_...` | Yes |
| `REGISTRATION_MODE` | Tenant registration policy | `closed` or `invite_only` | Yes |

## Secret Generation Instructions (Local Only)

Generate strong random secrets locally without outputting to repository or CI logs:

```bash
# Generate 32-byte random hex string for SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate 32-byte random hex string for PASSWORD_PEPPER
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
