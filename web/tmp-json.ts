type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
const obj: Json = { source: 'ui' };
