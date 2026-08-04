const payload = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
};

process.stdout.write(JSON.stringify(payload));
