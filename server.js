require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
// server.js
const allowedOrigins = [
    'http://localhost:4200',
    'https://pleats_with_dhiv.netlify.app'
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());


// Google Sheets API Configuration
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const KEY_FILE_PATH = 'config/service-account-key.json';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const CUSTOM_DATA_COLUMN_NAME = 'customData'; // Define your object column name here

// In server.js, modify how `auth` is initialized in `getSheetsClient()`:

async function getSheetsClient() {
    let authOptions;
    const keyFilePath = './config/service-account-key.json'; // Your local path

    if (process.env.SERVICE_ACCOUNT_JSON_STRING) {
        // Option 1: Key content is directly in an environment variable (good for many PaaS)
        try {
            const serviceAccountCredentials = JSON.parse(process.env.SERVICE_ACCOUNT_JSON_STRING);
            authOptions = {
                credentials: serviceAccountCredentials,
                scopes: SCOPES,
            };
        } catch (e) {
            console.error("Failed to parse SERVICE_ACCOUNT_JSON_STRING:", e);
            throw new Error("Invalid service account JSON string.");
        }
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        // Option 2: Path to key file is set by the environment (e.g., Render secret files, GCE)
        authOptions = {
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: SCOPES,
        };
    } else {
        // Option 3: Fallback to local file path for local development
        authOptions = {
            keyFile: keyFilePath,
            scopes: SCOPES,
        };
    }

    if (!authOptions.credentials && !authOptions.keyFile) {
         throw new Error("Service account credentials or keyFile must be provided.");
    }

    const auth = new JWT(authOptions);
    return google.sheets({ version: 'v4', auth });
}

async function getSheetGid(sheetsClient, targetSheetName) {
    try {
        const spreadsheetMeta = await sheetsClient.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
        });
        const sheet = spreadsheetMeta.data.sheets.find(s => s.properties.title === targetSheetName);
        if (!sheet) {
            throw new Error(`Sheet with name "${targetSheetName}" not found.`);
        }
        return sheet.properties.sheetId;
    } catch (error) {
        console.error('Error fetching sheet GID:', error);
        throw error;
    }
}

// Helper to safely parse JSON
function tryParseJSONObject(jsonString) {
    try {
        const o = JSON.parse(jsonString);
        if (o && typeof o === "object") {
            return o;
        }
    } catch (e) { }
    return null; // Return null or the original string if not a valid object JSON
}

// GET all customers
app.get('/api/customers', async (req, res) => {
    try {
        const sheets = await getSheetsClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${process.env.SHEET_NAME}!A:Z`, // Adjust range if more than 26 columns
        });

        const rows = response.data.values;
        if (rows && rows.length > 0) {
            const headers = rows[0];
            const customers = rows.slice(1).map(row => {
                let customer = {};
                headers.forEach((header, index) => {
                    let value = row[index] !== undefined ? row[index] : null;
                    if (header === CUSTOM_DATA_COLUMN_NAME && typeof value === 'string') {
                        customer[header] = tryParseJSONObject(value) || value; // Parse or keep as string if not valid JSON object
                    } else {
                        customer[header] = value;
                    }
                });
                return customer;
            });
            res.json(customers);
        } else {
            res.json([]);
        }
    } catch (error) {
        console.error('Error fetching customers:', error.message, error.response?.data);
        res.status(500).json({ error: 'Failed to fetch customers', details: error.message });
    }
});

// GET a single customer by ID
app.get('/api/customers/:id', async (req, res) => {
    const customerId = req.params.id;
    try {
        const sheets = await getSheetsClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${process.env.SHEET_NAME}!A:Z`,
        });

        const rows = response.data.values;
        if (rows && rows.length > 1) {
            const headers = rows[0];
            const idColumnIndex = headers.findIndex(header => header.toLowerCase() === 'id');

            if (idColumnIndex === -1) {
                return res.status(500).json({ error: "Sheet does not have an 'id' column in the header." });
            }
            
            const customerRow = rows.slice(1).find(row => row[idColumnIndex] === customerId);

            if (customerRow) {
                let customer = {};
                headers.forEach((header, index) => {
                    let value = customerRow[index] !== undefined ? customerRow[index] : null;
                     if (header === CUSTOM_DATA_COLUMN_NAME && typeof value === 'string') {
                        customer[header] = tryParseJSONObject(value) || value;
                    } else {
                        customer[header] = value;
                    }
                });
                res.json(customer);
            } else {
                res.status(404).json({ error: 'Customer not found' });
            }
        } else {
            res.status(404).json({ error: 'No data in sheet or customer not found' });
        }
    } catch (error) {
        console.error(`Error fetching customer ${customerId}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch customer', details: error.message });
    }
});

// POST (Create) a new customer
app.post('/api/customers', async (req, res) => {
    try {
        const sheets = await getSheetsClient();
        const newCustomerData = req.body;

        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${process.env.SHEET_NAME}!1:1`,
        });

        const headers = headerResponse.data.values ? headerResponse.data.values[0] : [];
        if (headers.length === 0) {
            return res.status(500).json({ error: 'Could not retrieve headers from sheet.' });
        }

        const valuesToAppend = [headers.map(header => {
            let value = newCustomerData[header];
            if (header === CUSTOM_DATA_COLUMN_NAME && typeof value === 'object' && value !== null) {
                return JSON.stringify(value);
            }
            return value !== undefined ? value : ""; // Default to empty string if undefined
        })];

        const resource = { values: valuesToAppend };
        const result = await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${process.env.SHEET_NAME}!A:A`,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource,
        }); 
        res.status(201).json({ message: 'Customer created successfully', data: newCustomerData, updates: result.data.updates });
    } catch (error) {
        console.error('Error creating customer:', error.message, error.response?.data?.error);
        res.status(500).json({ error: 'Failed to create customer', details: error.message });
    }
});

// PUT (Update) a customer by ID
app.put('/api/customers/:id', async (req, res) => {
    const customerId = req.params.id;
    const updatedCustomerData = req.body;
    try {
        const sheets = await getSheetsClient();

        const getResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${process.env.SHEET_NAME}!A:Z`,
        });

        const rows = getResponse.data.values;
        if (!rows || rows.length <= 1) {
            return res.status(404).json({ error: 'Customer not found or sheet is empty.' });
        }

        const headers = rows[0];
        const idColumnIndex = headers.findIndex(header => header.toLowerCase() === 'id');
        if (idColumnIndex === -1) {
            return res.status(500).json({ error: "Sheet does not have an 'id' column." });
        }

        let rowIndex = -1;
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][idColumnIndex] === customerId) {
                rowIndex = i;
                break;
            }
        }

        if (rowIndex === -1) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const actualSheetRowNumber = rowIndex + 1;

        const newRowValues = headers.map((header, colIndex) => {
            let value;
            if (updatedCustomerData.hasOwnProperty(header)) {
                value = updatedCustomerData[header];
                if (header === CUSTOM_DATA_COLUMN_NAME && typeof value === 'object' && value !== null) {
                    return JSON.stringify(value);
                }
                return value;
            }
            // If not in updatedCustomerData, keep the existing value from the sheet
            return rows[rowIndex][colIndex] !== undefined ? rows[rowIndex][colIndex] : "";
        });
        
        const rangeToUpdate = `${process.env.SHEET_NAME}!A${actualSheetRowNumber}:${String.fromCharCode(65 + headers.length - 1)}${actualSheetRowNumber}`;
        
        const resource = { values: [newRowValues] };
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: rangeToUpdate,
            valueInputOption: 'USER_ENTERED',
            resource,
        });

        res.json({ message: `Customer ${customerId} updated successfully`, data: updatedCustomerData });
    } catch (error) {
        console.error(`Error updating customer ${customerId}:`, error.message, error.response?.data?.error);
        res.status(500).json({ error: 'Failed to update customer', details: error.message });
    }
});

// DELETE a customer by ID (No changes needed here for customData unless deletion logic depends on it)
app.delete('/api/customers/:id', async (req, res) => {
    const customerId = req.params.id;
    try {
        const sheets = await getSheetsClient();
        const sheetGid = await getSheetGid(sheets, process.env.SHEET_NAME);

        const fullSheetResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${process.env.SHEET_NAME}!A:Z`,
        });
        const allRows = fullSheetResponse.data.values;
        if (!allRows || allRows.length <=1) {
             return res.status(404).json({ error: 'Customer not found or sheet too empty.' });
        }
        const headers = allRows[0];
        const idColumnIndex = headers.findIndex(h => h.toLowerCase() === 'id');
        if (idColumnIndex === -1) {
            return res.status(500).json({ error: "Sheet must have an 'id' header column." });
        }
        
        let rowIndexToDelete = -1; 
        for (let i = 1; i < allRows.length; i++) { 
            if (allRows[i][idColumnIndex] === customerId) {
                rowIndexToDelete = i; 
                break;
            }
        }

        if (rowIndexToDelete === -1) {
            return res.status(404).json({ error: 'Customer not found by ID for deletion.' });
        }

        const batchUpdateRequest = {
            requests: [
                {
                    deleteDimension: {
                        range: {
                            sheetId: sheetGid,
                            dimension: 'ROWS',
                            startIndex: rowIndexToDelete,
                            endIndex: rowIndexToDelete + 1,
                        },
                    },
                },
            ],
        };

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: batchUpdateRequest,
        });

        res.json({ message: `Customer ${customerId} deleted successfully` });
    } catch (error) {
        console.error(`Error deleting customer ${customerId}:`, error.message, error.response?.data?.error);
        res.status(500).json({ error: 'Failed to delete customer', details: error.message });
    }
});


app.listen(port, () => {
    console.log(`Backend proxy server running at http://localhost:${port}`);
    console.log(`Using Spreadsheet ID: ${SPREADSHEET_ID}`);
    console.log(`Using Sheet Name: ${process.env.SHEET_NAME}`);
    console.log(`Custom data will be handled in column: '${CUSTOM_DATA_COLUMN_NAME}'`);
});