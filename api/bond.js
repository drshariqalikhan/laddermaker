// api/bonds.js
export default async function handler(req, res) {
  // Enforce global origin clearance rules
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  try {
    // Official MAS open statistics daily benchmark analytics endpoint
    const url = 'https://mas.gov.sg';
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 PWA Proxy Engine' }
    });
    
    if (!response.ok) throw new Error(`MAS Server error: ${response.status}`);
    
    const data = await response.json();
    const record = data.result.records[0]; // Isolate the single most recent data record

    if (!record) {
      throw new Error('No records returned from MAS API matrix.');
    }

    // Explicitly parse string metrics returned by MAS into clean numerical yields
    const structuredCurve = [
      { code: 'BS26120W', maturity: '6-Month', yield: parseFloat(record['comp_sgs_6m_tb_yield'] || 0) },
      { code: 'BY26103X', maturity: '1-Year', yield: parseFloat(record['comp_sgs_1y_tb_yield'] || 0) },
      { code: 'N523100W', maturity: '2-Year', yield: parseFloat(record['comp_sgs_2y_grant_yield'] || 0) },
      { code: 'N523100W', maturity: '5-Year', yield: parseFloat(record['comp_sgs_5y_grant_yield'] || 0) },
      { code: 'NX21100N', maturity: '10-Year', yield: parseFloat(record['comp_sgs_10y_grant_yield'] || 0) },
      { code: 'NZ16100X', maturity: '15-Year', yield: parseFloat(record['comp_sgs_15y_grant_yield'] || 0) },
      { code: 'NY25200N', maturity: '20-Year', yield: parseFloat(record['comp_sgs_20y_grant_yield'] || 0) },
      { code: 'NZ26300E', maturity: '30-Year', yield: parseFloat(record['comp_sgs_30y_grant_yield'] || 0) },
      { code: 'NA24300E', maturity: '50-Year', yield: parseFloat(record['comp_sgs_50y_grant_yield'] || 0) }
    ];

    return res.status(200).json({
      date: record['end_of_day'],
      curve: structuredCurve
    });

  } catch (error) {
    console.error('Serverless Error Context:', error.message);
    return res.status(500).json({ error: 'Failed parsing external data asset pipelines.' });
  }
}
