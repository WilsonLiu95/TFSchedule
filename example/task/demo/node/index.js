var fs = require('fs-extra');
var path = require('path');
fs.writeFileSync(path.join(__dirname, 'publish', 'a.txt'), 'sdsds');
console.log(111);
setInterval(() => {
    console.log(22);
}, 1000)
