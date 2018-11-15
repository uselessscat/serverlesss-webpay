"use strict";

const AWS = require('aws-sdk');
const serverless = require('serverless-http');
const WebPay = require('webpay-nodejs');
const express = require('express');
const bodyParser = require('body-parser');
const uuid = require('uuid');
const cert = require('./certificates');

const dynamoDb = new AWS.DynamoDB.DocumentClient();
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
    // almacenar la fila en dynamo :: Este bloque no debe ir acá ::::::::::::::::::::::::::::::::::
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
    // :::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::

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
            buyOrder: payment_id.replace('-', '').substr(0, 26), // transbank max Length, posibilidades de hash collision?
            sessionId: req.sessionId,
            returnURL: url + '/dev/verificar?tid=' + payment_id + '&cid=' + charge_id,
            finalURL: url + '/dev/comprobante?tid=' + payment_id + '&cid=' + charge_id,
            amount: amount
        });

        // TODO :: no es mejor usar solo el put de arriba? 
        let updateResult = await dynamoDb.update({
            TableName: process.env.paymentsTableName,
            Key: {
                payment_id: payment_id,
                charge_id: charge_id
            },
            UpdateExpression: "SET token_ws_at = :tkd, token_ws = :tkval",
            ExpressionAttributeValues: {
                ":tkd": Date.now(),
                ":tkval": transaction.token || null
            },
            ReturnValues: "ALL_NEW"
        }).promise();

        res.redirect(transaction.url + '?token_ws=' + transaction.token);
    } catch (e) {
        res.send({ 'error': e })
    }
});

app.post('/verificar', async (req, res) => {
    let payment_id = req.query.tid;
    let charge_id = req.query.cid;
    let token_ws = req.body.token_ws;

    try {
        let transactionResult = await wp.getTransactionResult(token_ws);
        let acknowledge = await wp.acknowledgeTransaction(token_ws);

        let updateResult = await dynamoDb.update({
            TableName: process.env.paymentsTableName,
            Key: {
                payment_id: payment_id,
                charge_id: charge_id
            },
            UpdateExpression: "SET transaction_result = :tr, acknoledge_result = :ar",
            ExpressionAttributeValues: {
                ":tr": transactionResult,
                ":ar": acknowledge
            },
            ReturnValues: "ALL_NEW"
        }).promise();

        res.send(WebPay.getHtmlTransitionPage(transactionResult.urlRedirection, token_ws));
    } catch (e) {
        res.send({ 'error': e })
    }
}); 

app.post('/comprobante', async (req, res) => {
    let payment_id = req.query.tid;
    let charge_id = req.query.cid;
    let queryResult = {};

    try {
        queryResult = await dynamoDb.get({
            TableName: process.env.paymentsTableName,
            Key: {
                payment_id: payment_id,
                charge_id: charge_id
            }
        }).promise();
    } catch (e) {
        res.send({ 'error': e })
    }

    let html = JSON.stringify(queryResult);
    html += '<hr>';
    html += '<form action="/dev/anular" method="post"><input type="hidden" name="buyOrden" value="' + payment_id +
        '"><input type="submit" value="Anular"></form>'
    return res.send(html);
});

app.post('/anular', async (req, res) => {
    /*
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
        */
});

module.exports.handler = serverless(app);