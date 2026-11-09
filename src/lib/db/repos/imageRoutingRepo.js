import {createHash} from 'node:crypto';
import {getAdapter} from '../driver.js';
import {validateImageRouting,chooseImageRotation} from '../../../shared/utils/imageRouting.mjs';
const revision=config=>createHash('sha256').update(JSON.stringify(config)).digest('hex');
export class ImageRoutingError extends Error{constructor(code,status=409){super(code);this.code=code;this.status=status;}}
async function store(){const db=await getAdapter();if(!['node:sqlite','better-sqlite3','bun:sqlite'].includes(db.driver))throw new ImageRoutingError('durable_store_required',503);return db;}
function read(db){const row=db.get('SELECT data FROM settings WHERE id=1');const settings=row?JSON.parse(row.data):{};const config=validateImageRouting(settings.aurixImageRouting);return {settings,config,revision:revision(config)};}
export async function readImageRouting(){const db=await store();const {config,revision}=read(db);return {config,revision};}
export async function saveImageRouting(config,expected){config=validateImageRouting(config);const db=await store();return db.transaction(()=>{const current=read(db);if(current.revision!==expected)throw new ImageRoutingError('revision_conflict');db.run('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',[JSON.stringify({...current.settings,aurixImageRouting:config})]);return {config,revision:revision(config)};});}
export async function selectImageRotation(candidates,{provider,model,operation,stickyRequests,peekOnly=false}){
 const db=await store(),scope=JSON.stringify([operation,provider,model]);
 return db.transaction(()=>{const cursor=db.get('SELECT connectionId,useCount FROM aurixImageRoutingCursors WHERE scope=?',[scope]);const chosen=chooseImageRotation(candidates,cursor,stickyRequests);if(!chosen)return null;if(!peekOnly)db.run('INSERT INTO aurixImageRoutingCursors(scope,connectionId,useCount,updatedAt) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET connectionId=excluded.connectionId,useCount=excluded.useCount,updatedAt=excluded.updatedAt',[scope,chosen.connection.id,chosen.useCount,new Date().toISOString()]);return chosen.connection;});
}
