import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
const envFile = fs.readFileSync('.env.example', 'utf8');
const SUPABASE_URL = "https://wzmdxpskztprmxevltdk.supabase.co" // wait, let me extract from .env.example if exists
