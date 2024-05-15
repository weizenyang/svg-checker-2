import React, { useState, useEffect, useRef} from 'react';
import './object-list.css'

interface ObjectListProps {
}

const ObjectList: React.FC<ObjectListProps> = (props) => {
  const [eventData, setEventData] = useState<any>([]);
  const [csvEventData, setCsvEventData] = useState<any>([]);
  const currentSelected = useRef<any>(50000);
  useEffect(() => {
    const handleFileUpload = (event: CustomEvent) => {
      setEventData(eventData => [...eventData, event.detail])
    };

    const handleCSVFileUpload = (event: CustomEvent) => {
      setCsvEventData(csvEventData =>[...csvEventData, event.detail])
    };

    function clamp(num, min, max) {
      return num <= min 
        ? min 
        : num >= max 
          ? max 
          : num
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if(document.querySelector(".item-list").children.length > 0){
        if(event.key == "ArrowDown"){
          if(currentSelected.current == 50000){
            currentSelected.current = 0;
            currentSelected.current = clamp(currentSelected.current, 0, document.querySelector(".item-list").children.length)
            document.querySelector(".item-list").children[currentSelected.current].click()
            document.querySelector(".item-list").children[currentSelected.current].focus()
          } else {
            currentSelected.current++;
            currentSelected.current = clamp(currentSelected.current, 0, document.querySelector(".item-list").children.length)
            document.querySelector(".item-list").children[currentSelected.current].click()
            document.querySelector(".item-list").children[currentSelected.current].focus()
          }
        }

        if(event.key == "ArrowUp"){
          if(currentSelected.current == 50000){
            currentSelected.current = 0;
            currentSelected.current = clamp(currentSelected.current, 0, document.querySelector(".item-list").children.length)
            document.querySelector(".item-list").children[currentSelected.current].click()
            document.querySelector(".item-list").children[currentSelected.current].focus()
          } else {
            currentSelected.current--;
            currentSelected.current = clamp(currentSelected.current, 0, document.querySelector(".item-list").children.length)
            document.querySelector(".item-list").children[currentSelected.current].click()
            document.querySelector(".item-list").children[currentSelected.current].focus()
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown as EventListener)

    // Adding the event listener
    window.addEventListener('file-upload', handleFileUpload as EventListener);

    // Adding the event listener
    window.addEventListener('file-upload-csv', handleCSVFileUpload as EventListener);

    return () => {
      window.removeEventListener('file-upload', handleFileUpload as EventListener);
      window.removeEventListener('file-upload-csv', handleCSVFileUpload as EventListener);
      window.removeEventListener('keydown', handleKeyDown as EventListener);
    };
  }, []); // Empty dependency array means this effect runs only once on mount

  const switchEvent = (e, i, f) => {

    if(document.querySelector(".selected")){
      document.querySelector(".selected").classList.remove('selected')
    }

    window.dispatchEvent(new CustomEvent('object-switch', { detail: e }))
    currentSelected.current = i;
    console.log(f.target)
    f.target.classList.add("selected")
  }

  return (
    <ul className="item-list">
    {eventData.map((data, index) => {
      const csvEvent = csvEventData.find(csvData => csvData.simplifiedName === data.unitName)
      return (
        <button className="item-list-item-wrapper">
        <li className="item-list-item" key={`item-${index}`} onClick={(e) => {
            e.stopPropagation()
            switchEvent(data.unitName, index, e)
          }}>
            <p className="main-text">{data.unitName} {csvEvent && <span className="matched-csv">{csvEvent.name}</span>}</p>
            <p className="secondary-text">{data.fileName}</p>
        </li>
        {csvEvent && <div className="export-csv" onClick={(e) => {
          window.dispatchEvent(new CustomEvent("export-csv", {
              detail: csvEventData.find(csvData => csvData.simplifiedName === data.unitName) ? csvEventData.find(csvData => csvData.simplifiedName === data.unitName).name : ""
          }))
        }}>
          CSV
        </div>}
      </button>
      )
        
    }
    
          
      )}
  </ul>
  );
}

export default ObjectList;