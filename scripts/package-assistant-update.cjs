'use strict';
// Preserve the historical command name; packaging is now complete and source
// checked, with an explicit reviewed baseline and a new output directory.
require('./package-transactional-update.cjs').main().catch(error=>{console.error(error.message);process.exit(1);});

