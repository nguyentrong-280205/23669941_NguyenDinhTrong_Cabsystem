// Executed by mongosh. Idempotent bootstrap; never deletes existing databases.
const cabAdmin = db.getSiblingDB('admin');
const cabRoot = process.env.MONGO_ROOT_USER;
const cabPassword = process.env.MONGO_ROOT_PASSWORD;
let cabAuthenticated = false;
try { cabAuthenticated = !!cabAdmin.auth(cabRoot, cabPassword); } catch (_) {}
try { rs.status(); } catch (error) {
  if (error.code === 94) rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] });
  else throw error;
}
if (!db.hello().isWritablePrimary) quit(1);
if (!cabAuthenticated) { cabAdmin.createUser({ user: cabRoot, pwd: cabPassword, roles: ['root'] }); cabAdmin.auth(cabRoot, cabPassword); }
for (const cabOwner of ['customer','driver','trip','notification']) {
  const cabDatabase = db.getSiblingDB(`${cabOwner}_db`), cabUser = `${cabOwner}_user`;
  if (!cabDatabase.getUser(cabUser)) cabDatabase.createUser({ user: cabUser, pwd: process.env[`${cabOwner.toUpperCase()}_DB_PASSWORD`], roles: [{ role: 'dbOwner', db: `${cabOwner}_db` }] });
}
