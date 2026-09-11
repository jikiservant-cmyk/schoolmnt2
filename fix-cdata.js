const fs = require('fs');

const path = 'app/iclock/cdata/route.ts';
let content = fs.readFileSync(path, 'utf8');

// The file is a bit large to regex safely. I will rewrite the POST handler.
const postRegex = /export async function POST\(req: NextRequest\) \{[\s\S]*\}\s*$/;

// Well, let's just create a new file or replace it. I'll replace it using a script.
