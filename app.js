const express = require("express");
const ros = require("node-routeros");
const uuid = require("uuid");
const redis = require("redis");
const excel = require("exceljs");
const cors = require('cors');
const fs = require('fs');
const readline = require('readline');
const os = require('os');
const multer  = require('multer');
const { resolve } = require("path");

const upload = multer({ dest: os.tmpdir() });

// Load .env file
require("dotenv").config();

const redisClient = redis.createClient();
redisClient.on("error", e => {
  console.log(e);
});
redisClient.connect();

// Init express framework
const app = express();
const mikrotikCon = new ros.RouterOSAPI({
  host: process.env.MIKROTIK_HOST,
  user: process.env.MIKROTIK_USERNAME,
  password: process.env.MIKROTIK_PASSWORD
});

//
// Middleware
//
app.use(express.json());
app.use(cors({origin: '*', optionsSuccessStatus: 200,}));

//
// Middleware check authorize
//
midAuthorize = async (req, res, next) => {
  const token = await redisClient.get(process.env.ADMIN_USERNAME);
  if (token != req.headers.authorization) {
    res.send({
      data: { result: false },
      error: { description: "Not authorize" }
    });
    return;
  }
  return next();
};

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

//
// Routes
//

// User authen with username and password => token
// Store token to redis with expired time
app.post("/login", async (req, res) => {
  if (
    req.body.username != process.env.ADMIN_USERNAME ||
    req.body.password != process.env.ADMIN_PASSWORD
  ) {
    res.send({
      data: { result: false },
      error: { description: "Not authorize" }
    });
    return;
  }

  const token = uuid.v4();
  await redisClient.set(process.env.ADMIN_USERNAME, token);
  res.send({
    data: { result: true, token: token },
    error: {}
  });
});

//
app.get("/users", midAuthorize, (req, res) => {
  mikrotikCon
    .connect()
    .then(() => {
      mikrotikCon
        .write("/ip/hotspot/user/print")
        .then(data => {
          mikrotikCon.close();
          data = data.map(o => ({...o, id: o['.id']}));
          res.send({
            data: { result: true, items: data },
            error: { }
          });
        })
        .catch(e => {
          mikrotikCon.close();
          res.send({
            data: { result: false },
            error: { description: e.message }
          });
        });
    })
    .catch(e => {
      console.log(e);
      res.send({
        data: { result: false },
        error: { description: "failure: somthing invalid, call administrator" }
      });
    });
});

//
app.post("/users/add", midAuthorize, (req, res) => {
  // console.log(req.body);
  mikrotikCon
    .connect()
    .then(() => {
      mikrotikCon
        .write("/ip/hotspot/user/add", [
          "=name=" + req.body.name,
          "=password=" + req.body.password,
          "=profile=" + req.body.profile
        ])
        .then(data => {
          mikrotikCon.close();
          res.send({ data: { result: true }, error: {} });
        })
        .catch(e => {
          mikrotikCon.close();
          res.send({
            data: { result: false },
            error: { description: e.message }
          });
        });
    })
    .catch(e => {
      console.log(e);
      res.send({
        data: { result: false },
        error: { description: "failure: somthing invalid, call administrator" }
      });
    });
});

//
app.delete("/users/:id", midAuthorize, (req, res) => {
  mikrotikCon
    .connect()
    .then(() => {
      mikrotikCon
        .write("/ip/hotspot/user/remove", ["=numbers=" + req.params.id])
        .then(data => {
          mikrotikCon.close();
          res.send({ data: { result: true }, error: {} });
        })
        .catch(e => {
          mikrotikCon.close();
          res.send({
            data: { result: false },
            error: { description: e.message }
          });
        });
    })
    .catch(e => {
      console.log(e);
      res.send({
        data: { result: false },
        error: { description: "failure: somthing invalid, call administrator" }
      });
    });
});

//
app.post("/import", upload.single('file'), async (req, res) => {
  if(req.file.mimetype != 'text/csv') {
    res.send({
      data: { result: false },
      error: { description: "failure: file is not csv format" }
    });
    return;
  }

  let lines = [];
  
  let rl = readline.createInterface({
    input: fs.createReadStream(req.file.path),
    console: false
  });

  for await (const line of rl) {
    lines.push(line);
  }

  // add user
  try {
    mikrotikCon
    .connect()
    .then(async () => {
      for(let i=0; i<lines.length; i++) {
        let tokens = lines[i].split(',');
        // console.log(tokens);
        if(mikrotikCon.connected) {
          await mikrotikCon.write("/ip/hotspot/user/add", [
              "=name=" + tokens[0],
              "=password=" + tokens[1],
              "=profile=" + tokens[2]
            ]).catch(e => {
              console.log(e);
            });
        }
        sleep(1000);
      }
      mikrotikCon.close();
    });
  } catch (e) {
    console.log(e);
    mikrotikCon.close();
  }

  res.send({ data: { result: true }, error: {} });
});

//
app.get("/export", midAuthorize, (req, res) => {
  mikrotikCon
    .connect()
    .then(() => {
      mikrotikCon
        .write("/ip/hotspot/user/print")
        .then(data => {
          mikrotikCon.close();
          // Build excel file
          let wb = new excel.Workbook();
          let ws = wb.addWorksheet("Users");
          ws.columns = [
            { header: "Username", key: "username" },
            { header: "Password", key: "password" },
            { header: "Profile", key: "profile" }
          ];
          data.map((item, index) => {
            ws.addRow({
              username: item.name,
              password: item.password,
              profile: item.profile
            });
          });
          // Return file
          let filename = "report-" + new Date().getTime() + ".xlsx";
          wb.xlsx.writeFile("./public/download/report/" + filename);
          res.send({ result: true, file: filename });
        })
        .catch(e => {
          mikrotikCon.close();
          res.send({
            data: { result: false },
            error: { description: e.message }
          });
        });
    })
    .catch(e => {
      console.log(e);
      res.send({
        data: { result: false },
        error: { description: "failure: somthing invalid, call administrator" }
      });
    });
});

//
app.get("/download/:filename", (req, res) => {
  fs.readFile("./public/download/report/" + req.params.filename, (e, data) => {
    if (e) {
      console.log(e);
      res.send({
        data: { result: false },
        error: { description: e.message }
      });
      return;
    }
    res.write(data);
    return res.end();
  });
});

//
// Start listener
//
app.listen(process.env.PORT, () => {
  console.log("Start server at port " + process.env.PORT);
});
