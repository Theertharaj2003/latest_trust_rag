import { createApp } from './app.mjs';
import { databaseStore } from '../../db/index.mjs';
export default createApp(databaseStore());
