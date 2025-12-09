import admin from 'firebase-admin'

// Minimal admin initializer for server bundling. This mirrors the padd-ui helper
// but keeps a local copy so the server build doesn't depend on files outside
// the server folder.
if (!admin.apps.length) {
  const dbUrl = process.env.FB_DB_URL ?? process.env.FIREBASE_DATABASE_URL

  const svcJsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FB_SA_JSON || process.env.SERVICE_ACCOUNT_JSON
  const svcJsonB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.SERVICE_ACCOUNT_BASE64 || process.env.FB_SA_B64
  if (svcJsonRaw || svcJsonB64) {
    try {
      let parsed: any = null
      if (svcJsonRaw) parsed = JSON.parse(svcJsonRaw)
      else parsed = JSON.parse(Buffer.from(svcJsonB64 as string, 'base64').toString('utf8'))
      admin.initializeApp({ credential: admin.credential.cert(parsed as any), databaseURL: dbUrl })
      console.info('[SERVER] Firebase admin initialized from SERVICE_ACCOUNT env')
    } catch (err) {
      console.warn('[SERVER] firebase admin init from env failed', err)
    }
  }

  if (!admin.apps.length) {
    const projectId = process.env.FB_PROJECT_ID
    const clientEmail = process.env.FB_CLIENT_EMAIL
    const privateKey = process.env.FB_PRIVATE_KEY
    if (projectId && clientEmail && privateKey) {
      try {
        admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }), databaseURL: dbUrl })
        console.info('[SERVER] Firebase admin initialized from FB_PRIVATE_KEY env')
      } catch (err) {
        console.warn('[SERVER] firebase admin init (private key) failed', err)
      }
    }
  }

  if (!admin.apps.length) {
    try {
      admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: dbUrl })
      console.info('[SERVER] Firebase admin initialized with applicationDefault credentials')
    } catch (err) {
      console.warn('[SERVER] firebase admin final init failed', err)
    }
  }
}

export function getAdminDb() {
  if (!admin.apps || !admin.apps.length) {
    throw new Error('Firebase Admin not initialized; set service account or application credentials')
  }
  try {
    return admin.database()
  } catch (err) {
    console.error('[SERVER] admin.database() error', err)
    throw err
  }
}

export default admin
