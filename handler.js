"use strict";

const AWS = require('aws-sdk');
const serverless = require('serverless-http');
const WebPay = require('webpay-nodejs');
const express = require('express');
const bodyParser = require('body-parser');
const uuid = require('uuid');
const cert = require('./certificates');

const onError = function (err, res) {
    console.log('ERROR', err)
    res.send(`
      <html>
          <head><meta charset="utf-8"></head>
          <body>
            <h1>ERROR</h1>
            <pre>
            ${err.stack}
            </pre>
          </body>
      </html>
    `)
};

let transactions = {};
let transactionsByToken = {};
let app = express();

app.use(bodyParser.urlencoded({ extended: true }));

let wp = new WebPay({
    commerceCode: cert.commerceCode,
    publicKey: cert.publicKey,
    privateKey: cert.privateKey,
    webpayKey: cert.webpayKey,
    verbose: true,
    env: WebPay.ENV.INTEGRACION
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
    <head>
        <title>Test webpay-nodejs</title>
    </head>
    <body>
        <h1>Test webpay-nodejs</h1>
        <form action="/dev/pagar" method="post">
            <input type="number" min="10" placeholder="Monto a pagar" name="amount">
            <input type="submit" value="Pagar">
        </form>
    </body>
</html>`);
});

app.post('/pagar', async (req, res) => {
    const dynamoDb = new AWS.DynamoDB.DocumentClient();

    // almacenar la fila en dynamo :: esto es temporal y deberia existir desde antes
    let charge_id = uuid.v1();
    let amount = req.body.amount;
    try {
        let result = await dynamoDb.put({
            TableName: process.env.chargesTableName,
            Item: {
                charge_id: charge_id,
                user_id: '1',
                amount: amount,
                created_at: Date.now()
            }
        }).promise();
    } catch (e) {
        res.send({ 'error': e })
    }

    try {
        let payment_id = uuid.v1();

        // ingresar el intento de pago
        let paymentResult = await dynamoDb.put({
            TableName: process.env.paymentsTableName,
            Item: {
                payment_id: payment_id,
                charge_id: charge_id,
                amount: amount,
                created_at: Date.now(),
                status: 'created'
            }
        }).promise();

        // enviar peticion a webpay
        let url = 'http://' + req.get('host');
        let transaction = await wp.initTransaction({
            buyOrder: payment_id.replace('-', '').substr(0, 26), // transbank max Length
            sessionId: req.sessionId,
            returnURL: url + '/dev/verificar',
            finalURL: url + '/dev/comprobante',
            amount: amount
        });

        // actualizar 
        let updateResult = await dynamoDb.update({
            TableName: process.env.paymentsTableName,
            Key: {
                payment_id: payment_id,
                charge_id: charge_id
            },
            UpdateExpression: "SET token_ws_at = :token_ws_date, token_ws = :token_ws",
            ExpressionAttributeValues: {
                ":token_ws_date": Date.now(),
                ":token_ws": transaction.token || null
            },
            ReturnValues: "ALL_NEW"
        }).promise();

        res.redirect(transaction.url + '?token_ws=' + transaction.token);
    } catch (e) {
        res.send({ 'error': e })
    }
});

app.post('/verificar', async (req, res) => {

    let token = req.body.token_ws;
    let transaction;

    console.log('pre token', token);
    wp.getTransactionResult(token).then((transactionResult) => {
        transaction = transactionResult;
        transactions[transaction.buyOrder] = transaction;
        transactionsByToken[token] = transactions[transaction.buyOrder];

        return wp.acknowledgeTransaction(token);

    }).then((result2) => {
        res.send(WebPay.getHtmlTransitionPage(transaction.urlRedirection, token));
    }).catch(onError(res));

});

app.post('/comprobante', async (req, res) => {
    const transaction = transactionsByToken[req.body.token_ws];
    let html = JSON.stringify(transaction);
    html += '<hr>';
    html += '<form action="/dev/anular" method="post"><input type="hidden" name="buyOrden" value="' + transaction.buyOrder +
        '"><input type="submit" value="Anular"></form>'
    return res.send(html);
});

app.post('/anular', async (req, res) => {

    const transaction = transactions[req.body.buyOrden];

    wp.nullify({
        authorizationCode: transaction.detailOutput.authorizationCode,
        authorizedAmount: transaction.detailOutput.amount,
        nullifyAmount: transaction.detailOutput.amount,
        buyOrder: transaction.buyOrder
    }).then((result) => {
        console.log('anulación:', result);
        return res.send('comprobante:' + JSON.stringify(transaction));
    }).catch(onError(res));
});

module.exports.handler = serverless(app);