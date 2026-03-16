import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import path from 'path';
import url from 'url';
import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../utils/ApiError.js';
import fs from 'fs';
import cron from 'node-cron';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OAuth2 = google.auth.OAuth2;

/**
 * Replace {{placeholders}} in the HTML template with actual values
 */
function injectTemplateData(template, data) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => data[key] || '');
}

const isTokenExpired = (token) => {
  let currentTimestamps = Date.now();
  return currentTimestamps >= token.expire_date;
};

const saveTokenResponse = (tokens) => {
  const token_data = {
    access_token: tokens?.access_token,
    refresh_token: tokens?.refresh_token || process.env.REFRESH_TOKEN,
    expiry_date: tokens?.expiry_date,
  };

  fs.writeFileSync('tokens.json', JSON.stringify(token_data));
};

const loadTokens = () => {
  if (fs.existsSync('tokens.json')) {
    const token_data = fs.readFileSync('tokens.json');

    return JSON.parse(token_data);
  }

  return null;
};

const refreshAccessToken = async (refreshToken, clientId, clientSecret) => {
  const OAuth2Client = new OAuth2(
    clientId,
    clientSecret,
    'https://developers.google.com/oauthplayground',
  );

  OAuth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  try {
    const tokens = await OAuth2Client.refreshAccessToken();
    OAuth2Client.setCredential(tokens.credentials);

    saveTokenResponse(tokens.credentials);

    return tokens.credentials.access_token;
  } catch (error) {
    throw new ApiError(
      StatusCodes.UNAUTHORIZED,
      `Error occured while refreshing access token: ${error}`,
    );
  }
};

const createTransporter = async () => {
  const tokens = loadTokens();

  const OAuth2Client = new OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    'https://developers.google.com/oauthplayground',
  );

  OAuth2Client.setCredentials({
    access_token: tokens ? tokens?.access_token : process.env.ACCESS_TOKEN,
    refresh_token: tokens ? tokens?.refresh_token : process.env.REFRESH_TOKEN,
    token_type: 'Bearer',
    expiry_date: tokens ? tokens?.expiry_date : process.env.EXPIRY_DATE,
  });

  OAuth2Client.generateAuthUrl({
    scope: process.env.SCOPES,
    include_granted_scopes: true,
  });

  if (isTokenExpired(OAuth2Client.credentials)) {
    console.log('Access token expired Refreshing...');

    await refreshAccessToken(
      OAuth2Client.credentials.refresh_token,
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
    );
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: process.env.EMAIL,
      pass: process.env.EMAIL_HOST_PASSWORD,
      accessToken: OAuth2Client.credentials.access_token,
      refreshToken: OAuth2Client.credentials.refresh_token,
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      pass: process.env.EMAIL_HOST_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false, // This line bypasses SSL certificate verification
    },
  });
};

/**
 *
 * @param {{ to: string, subject: string, templateName: string, data: any }} emailOptions
 * @returns
 */
const sendMail = async (emailOptions) => {
  try {
    const { to, subject, templateName, data } = emailOptions;

    const transporter = await createTransporter();
    if (!transporter) {
      console.error('Failed to create transporter');
      return;
    }

    const templatePath = path.resolve(__dirname, `../service/emails/${templateName}.html`);
    const rawHtml = fs.readFileSync(templatePath, 'utf8');
    const finalHtml = injectTemplateData(rawHtml, data);

    const options = {
      from: process.env.EMAIL,
      to,
      subject,
      html: finalHtml,
    };

    const info = await transporter.sendMail(options);
    console.log('Message Id: %s', info.messageId);
  } catch (error) {
    console.log(`Error sending email: ${error.message}`);
  }
};

export { sendMail };

cron.schedule('* */5 * * *', async () => {
  try {
    await refreshAccessToken(
      process.env.REFRESH_TOKEN,
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
    );
  } catch (error) {
    console.error('failed to refresh token during schedule job', error);
  }
});
